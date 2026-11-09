import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../process/exec.js";
import {
  createDiagnosticFixtureRouting,
  diagnosticCanaries,
  diagnosticEnvReportScript,
  withSyntheticDiagnosticEnv,
} from "./diagnostic-env.test-support.js";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn(), run: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: mocks.exec,
  spawnSync: mocks.spawn,
}));
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.run }));

const routing = createDiagnosticFixtureRouting({
  Path: "C:\\SyntheticTools",
  SystemRoot: "C:\\SyntheticWindows",
  WINDIR: "C:\\SyntheticWindows",
  ComSpec: "C:\\SyntheticWindows\\System32\\cmd.exe",
  PATHEXT: ".EXE;.COM",
  USERPROFILE: "C:\\Users\\fixture",
  LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local",
  TEMP: "C:\\Temp",
  PSModuleAnalysisCachePath: "C:\\Temp\\ModuleAnalysisCache",
});
const system32 = "D:\\RegistryWindows\\System32";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
});

const literalCommand =
  String.raw`"C:\Program Files\node.exe" "C:\Team Notes\\" "Office \"A\"" "" "%%PATH%% ^!value!"` +
  ' "first\r\nsecond"';
const literalArgs = [
  "C:\\Program Files\\node.exe",
  "C:\\Team Notes\\",
  'Office "A"',
  "",
  "%%PATH%% ^!value!",
  "first\r\nsecond",
];

it.each([false, true])("rejects malformed native argv, WMIC fallback=%s", async (fallback) => {
  const { readWindowsProcessArgsResultSync } = await import("./windows-port-pids.js");
  if (fallback) {
    mocks.spawn.mockReturnValueOnce({ status: 1, stdout: "" });
  }
  mocks.spawn.mockReturnValueOnce({
    status: 0,
    stdout: fallback ? "CommandLine=node\0 gateway\r\n" : "node\0 gateway",
  });

  expect(readWindowsProcessArgsResultSync(424242, 1_000, routing)).toEqual({
    ok: false,
    permanent: false,
  });
});

it.each(["supplied", "exhausted", "partial"] as const)(
  "bounds argv discovery including root resolution (%s)",
  async (registryBudget) => {
    const { readWindowsProcessArgsSync } = await import("./windows-port-pids.js");
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    mocks.spawn.mockImplementation((_file, _args, options) => {
      elapsedMs += Number(options?.timeout ?? 0);
      return { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), status: null };
    });
    if (registryBudget === "supplied") {
      expect(readWindowsProcessArgsSync(424242, 1_000, routing, 125)).toBeNull();
      expect(elapsedMs).toBe(125);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      return;
    }
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    const registryRoot = "SystemRoot    REG_SZ    D:\\RegistryWindows\r\n";
    mocks.exec.mockImplementation((_file, _args, options) => {
      if (registryBudget === "exhausted") {
        elapsedMs += Number(options?.timeout ?? 0);
        throw Object.assign(new Error("registry timed out"), { code: "ETIMEDOUT" });
      }
      elapsedMs += 40;
      return registryRoot;
    });

    await withSyntheticDiagnosticEnv(routing, async () => {
      expect(readWindowsProcessArgsSync(424242, 1_000, process.env, 125)).toBeNull();
      expect.soft(elapsedMs).toBe(125);
      expect.soft(mocks.exec).toHaveBeenCalledOnce();
      expect.soft(mocks.spawn).toHaveBeenCalledTimes(registryBudget === "exhausted" ? 0 : 1);

      // A short observation must not cache its unverified environment fallback.
      mocks.exec.mockReturnValue(registryRoot);
      mocks.spawn.mockReturnValue({ status: 0, stdout: "node fixture-server" });
      expect(readWindowsProcessArgsSync(424242)).toEqual(["node", "fixture-server"]);
      expect(mocks.spawn.mock.lastCall?.[0]).toBe(
        `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
      );
    });
  },
);

async function withWindowsDiagnostics(fallback: boolean, run: () => Promise<void>) {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const access = fs.accessSync;
  vi.spyOn(fs, "accessSync").mockImplementation((file, mode) => {
    if (String(file) === "C:\\Windows\\System32\\reg.exe") {
      return;
    }
    access(file, mode);
  });
  await withSyntheticDiagnosticEnv(routing, async () => {
    const parent = { ...process.env };
    const reports: Array<[string, unknown]> = [];
    // Windows command output is mocked on POSIX. Each selected child env also reaches a real
    // Node subprocess, proving inheritance independently of the synthetic utility output.
    const capture = (file: string, env?: NodeJS.ProcessEnv) => {
      const stdout = native.execFileSync(
        process.execPath,
        ["-e", `process.stdout.write(${diagnosticEnvReportScript(routing)})`],
        { env, encoding: "utf8", timeout: 5000 },
      );
      reports.push([path.win32.basename(file), JSON.parse(stdout)]);
    };
    mocks.exec.mockImplementation(
      (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        capture(file, options.env);
        const value = args[3];
        return `${value}    REG_SZ    ${value === "OEMCP" ? "437" : value === "SystemRoot" ? "D:\\RegistryWindows" : "D:\\Programs"}\r\n`;
      },
    );
    const reply = (
      file: string,
      args: string[],
      env?: NodeJS.ProcessEnv,
      commandLine = literalCommand,
    ) => {
      capture(file, env);
      const command = path.win32.basename(file);
      const script = args.join(" ");
      let stdout = "";
      let status = 0;
      if (command === "netstat.exe") {
        stdout =
          "TCP 127.0.0.1:43123 0.0.0.0:0 LISTENING 424242\nTCP 127.0.0.1:43123 127.0.0.1:54321 ESTABLISHED 424242\n";
      } else if (command === "tasklist.exe") {
        stdout = '"node.exe","424242","Console","1","100 K"\n';
      } else if (command === "cmd.exe") {
        stdout = "Active code page: 65001";
      } else if (script.includes("Default.CodePage")) {
        stdout = "1252";
      } else if (command === "powershell.exe" && fallback) {
        status = 1;
      } else if (script.includes("Get-NetTCPConnection")) {
        stdout = "424242";
      } else if (script.includes("CreationDate") || script.includes(".StartTime")) {
        stdout =
          command === "wmic.exe"
            ? "CreationDate=20260903000000.000000+000"
            : "2026-09-03T00:00:00Z";
      } else {
        stdout = command === "wmic.exe" ? `CommandLine=${commandLine}` : commandLine;
      }
      return { status, stdout, stderr: "" };
    };
    mocks.spawn.mockImplementation(
      (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) =>
        reply(file, args, options.env),
    );
    mocks.run.mockImplementation(
      async ([file, ...args]: [string, ...string[]], options: CommandOptions) => {
        const result = reply(file, args, options.baseEnv, "node fixture-server");
        return { ...result, code: result.status };
      },
    );
    await run();
    expect(process.env).toEqual(parent);
    expect(reports.length).toBeGreaterThan(0);
    for (const [command, report] of reports) {
      expect(report, `${command} inherited canary presence`).toEqual({
        defined: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, false])),
        routingPreserved: true,
      });
    }
  });
}

describe("Windows diagnostic child environments (mocked utilities)", () => {
  it.each(
    [false, true].flatMap((fallback) => ["ports", "process"].map((api) => ({ fallback, api }))),
  )("isolates $api utility environments, fallback=$fallback", async ({ fallback, api }) => {
    const ports = await import("./ports-inspect.js");
    const pids = await import("./windows-port-pids.js");
    const start = await import("./windows-process-start.js");
    await withWindowsDiagnostics(fallback, async () => {
      if (api === "process") {
        // Exercise utility forwarding without native inspection of the fixture PID.
        vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
        expect(pids.readWindowsListeningPidsOnPortSync(43123)).toEqual([424242]);
        expect(pids.readWindowsProcessArgsResultSync(424242)).toEqual({
          ok: true,
          args: literalArgs,
        });
        expect(start.readWindowsProcessStartTimeSync(424242)).toBe(
          Date.parse("2026-09-03T00:00:00Z"),
        );
        expect(new Set(mocks.spawn.mock.calls.map(([file]) => path.win32.basename(file)))).toEqual(
          new Set(["powershell.exe", ...(fallback ? ["netstat.exe", "wmic.exe"] : [])]),
        );
        return;
      }
      const single = await ports.inspectPortUsage(43123);
      const batch = await ports.inspectPortUsages([43123]);
      const connections = await ports.inspectPortConnections(43123);
      for (const entries of [
        single.listeners,
        batch.get(43123)?.listeners,
        connections.connections,
      ]) {
        expect(entries).toEqual([
          expect.objectContaining({
            pid: 424242,
            command: "node.exe",
            commandLine: "node fixture-server",
          }),
        ]);
      }
      const commands = mocks.run.mock.calls.map(([argv]) => path.win32.basename(argv[0]));
      expect(new Set(commands)).toEqual(
        new Set([
          "netstat.exe",
          "tasklist.exe",
          "powershell.exe",
          ...(fallback ? ["wmic.exe"] : []),
        ]),
      );
      expect(mocks.run.mock.calls[0]?.[0][0]).toBe(`${system32}\\netstat.exe`);
    });
  });

  it("keeps cold registry authority and caches root/code-page probes", async () => {
    const roots = await import("./windows-install-roots.js");
    const encoding = await import("./windows-encoding.js");
    await withWindowsDiagnostics(false, async () => {
      expect(encoding.resolveWindowsConsoleEncoding()).toBe("utf-8");
      expect(mocks.exec.mock.calls.map(([, args]) => args[3])).toEqual(["SystemRoot"]);
      expect(mocks.exec).toHaveBeenCalledTimes(1);
      roots.getWindowsInstallRoots();
      roots.getWindowsInstallRoots();
      expect(mocks.exec.mock.calls.map(([, args]) => args[3])).toEqual([
        "SystemRoot",
        "ProgramFilesDir",
        "ProgramFilesDir (x86)",
        "ProgramW6432Dir",
      ]);
      expect(encoding.decodeWindowsTextFileBuffer({ buffer: Buffer.from([0x80]) })).toBe("€");
      expect(encoding.resolveWindowsOemCodePage()).toBe(437);
      encoding.resolveWindowsConsoleEncoding();
      encoding.decodeWindowsTextFileBuffer({ buffer: Buffer.from([0x80]) });
      encoding.resolveWindowsOemCodePage();
      expect([
        mocks.exec.mock.calls.length,
        mocks.spawn.mock.calls.length,
        mocks.spawn.mock.calls[0]?.[0],
      ]).toEqual([5, 2, `${system32}\\cmd.exe`]);
    });
  });
});
