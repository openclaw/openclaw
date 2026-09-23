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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.resetModules();
});

it("does not start the argv fallback after the ownership inspection deadline", async () => {
  const { readWindowsProcessArgsSync } = await import("./windows-port-pids.js");
  let elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  mocks.spawn.mockImplementation((_file, _args, options) => {
    elapsedMs += Number(options?.timeout ?? 0);
    return { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), status: null };
  });

  expect(readWindowsProcessArgsSync(424242, 1_000, routing, 125)).toBeNull();
  expect(elapsedMs).toBe(125);
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it.each(["exhausted", "partial"] as const)(
  "includes the %s cold-registry lookup in the argv allowance",
  async (registryBudget) => {
    const { readWindowsProcessArgsSync } = await import("./windows-port-pids.js");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const registryRoot = "SystemRoot    REG_SZ    D:\\RegistryWindows\r\n";
    mocks.exec.mockImplementation((_file, _args, options) => {
      if (registryBudget === "exhausted") {
        elapsedMs += Number(options?.timeout ?? 0);
        throw Object.assign(new Error("registry timed out"), { code: "ETIMEDOUT" });
      }
      elapsedMs += 40;
      return registryRoot;
    });
    mocks.spawn.mockImplementation((_file, _args, options) => {
      elapsedMs += Number(options?.timeout ?? 0);
      return { error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), status: null };
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
        "D:\\RegistryWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
    });
  },
);

async function withWindowsDiagnostics(
  fallback: boolean,
  run: (modules: {
    ports: typeof import("./ports-inspect.js");
    roots: typeof import("./windows-install-roots.js");
    encoding: typeof import("./windows-encoding.js");
    pids: typeof import("./windows-port-pids.js");
    start: typeof import("./windows-process-start.js");
  }) => Promise<void>,
) {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const modules = {
    ports: await import("./ports-inspect.js"),
    roots: await import("./windows-install-roots.js"),
    encoding: await import("./windows-encoding.js"),
    pids: await import("./windows-port-pids.js"),
    start: await import("./windows-process-start.js"),
  };
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
    const reports: Array<{ command: string; report: unknown }> = [];
    // Windows command output is mocked on POSIX. Each selected child env also reaches a real
    // Node subprocess, proving inheritance independently of the synthetic utility output.
    const capture = (file: string, env?: NodeJS.ProcessEnv) => {
      const stdout = native.execFileSync(
        process.execPath,
        ["-e", `process.stdout.write(${diagnosticEnvReportScript(routing)})`],
        { env, encoding: "utf8", timeout: 5000 },
      );
      reports.push({ command: path.win32.basename(file), report: JSON.parse(stdout) });
    };
    mocks.exec.mockImplementation(
      (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
        capture(file, options.env);
        const value = args[3];
        return `${value}    REG_SZ    ${value === "OEMCP" ? "437" : value === "SystemRoot" ? "D:\\RegistryWindows" : "D:\\Programs"}\r\n`;
      },
    );
    const reply = (file: string, args: string[], env?: NodeJS.ProcessEnv) => {
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
        stdout = command === "wmic.exe" ? "CommandLine=node fixture-server" : "node fixture-server";
      }
      return { status, stdout, stderr: "" };
    };
    mocks.spawn.mockImplementation(
      (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) =>
        reply(file, args, options.env),
    );
    mocks.run.mockImplementation(
      async ([file, ...args]: [string, ...string[]], options: CommandOptions) => {
        const result = reply(file, args, options.baseEnv);
        return { ...result, code: result.status };
      },
    );
    await run(modules);
    expect(process.env).toEqual(parent);
    expect(reports.length).toBeGreaterThan(0);
    for (const { command, report } of reports) {
      expect(report, `${command} inherited canary presence`).toEqual({
        defined: Object.fromEntries(Object.keys(diagnosticCanaries).map((key) => [key, false])),
        routingPreserved: true,
      });
    }
  });
}

describe("Windows diagnostic child environments (mocked utilities)", () => {
  it.each([false, true])("covers every port command family, WMIC fallback=%s", async (fallback) => {
    await withWindowsDiagnostics(fallback, async ({ ports }) => {
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
      expect(mocks.run.mock.calls[0]?.[0][0]).toBe("D:\\RegistryWindows\\System32\\netstat.exe");
    });
  });

  it("keeps cold registry authority and caches root/code-page probes", async () => {
    await withWindowsDiagnostics(false, async ({ roots, encoding }) => {
      expect(encoding.resolveWindowsConsoleEncoding()).toBe("utf-8");
      expect(mocks.exec.mock.calls.map(([, args]) => args[3])).toEqual(["SystemRoot"]);
      expect(roots.getWindowsPowerShellExePath()).toBe(
        "D:\\RegistryWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(roots.getWindowsWmicExePath()).toBe("D:\\RegistryWindows\\System32\\wbem\\wmic.exe");
      expect(mocks.exec).toHaveBeenCalledTimes(1);
      const installRoots = roots.getWindowsInstallRoots();
      expect(installRoots).toEqual({
        systemRoot: "D:\\RegistryWindows",
        programFiles: "D:\\Programs",
        programFilesX86: "D:\\Programs",
        programW6432: "D:\\Programs",
      });
      expect(roots.getWindowsInstallRoots()).toBe(installRoots);
      expect(roots.getWindowsProgramFilesRoots()).toEqual(["D:\\Programs"]);
      expect(mocks.exec.mock.calls.map(([, args]) => args[3])).toEqual([
        "SystemRoot",
        "ProgramFilesDir",
        "ProgramFilesDir (x86)",
        "ProgramW6432Dir",
      ]);
      expect(encoding.decodeWindowsTextFileBuffer({ buffer: Buffer.from([0x80]) })).toBe("€");
      expect(encoding.resolveWindowsOemCodePage()).toBe(437);
      expect(roots.getWindowsSystem32ExePath("netstat.exe")).toBe(
        "D:\\RegistryWindows\\System32\\netstat.exe",
      );
      encoding.resolveWindowsConsoleEncoding();
      encoding.decodeWindowsTextFileBuffer({ buffer: Buffer.from([0x80]) });
      encoding.resolveWindowsOemCodePage();
      expect(mocks.exec).toHaveBeenCalledTimes(5);
      expect(mocks.spawn).toHaveBeenCalledTimes(2);
      expect(mocks.spawn.mock.calls[0]?.[0]).toBe("D:\\RegistryWindows\\System32\\cmd.exe");
    });
  });

  it.each([false, true])(
    "isolates synchronous listener/argv/start-time reads, fallback=%s",
    async (fallback) => {
      // Exercise utility environment forwarding without querying a real process with the fixture PID.
      vi.stubGlobal("SEALED_RUNTIME_BUILD", true);
      await withWindowsDiagnostics(fallback, async ({ pids, start }) => {
        expect(pids.readWindowsListeningPidsOnPortSync(43123)).toEqual([424242]);
        expect(pids.readWindowsProcessArgsSync(424242)).toEqual(["node", "fixture-server"]);
        expect(start.readWindowsProcessStartTimeSync(424242)).toBe(
          Date.parse("2026-09-03T00:00:00Z"),
        );
        expect(new Set(mocks.spawn.mock.calls.map(([file]) => path.win32.basename(file)))).toEqual(
          new Set(["powershell.exe", ...(fallback ? ["netstat.exe", "wmic.exe"] : [])]),
        );
      });
    },
  );
});
