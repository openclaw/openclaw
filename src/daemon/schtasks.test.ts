// Windows schtasks tests cover scheduled task service lifecycle behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import { assertDaemonRuntimePinDefinition } from "./runtime-pin-state.js";
import {
  buildHiddenLauncherScript,
  buildTaskScript,
  buildStartupLauncherScript,
  readScheduledTaskCommand,
  resolveStartupEntryPaths,
  resolveTaskScriptPath,
} from "./schtasks-layout.js";
import { isScheduledTaskEnabled, readScheduledTaskRuntime } from "./schtasks-runtime.js";
import { hasGatewayServiceLauncherOverride } from "./service-types.js";

const resolveWindowsOemEncodingMock = vi.hoisted(() => vi.fn((): string | null => null));
const spawnSync = vi.hoisted(() => vi.fn());
const temporary = useAutoCleanupTempDirTracker(afterEach);

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawnSync,
}));

vi.mock("../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/windows-encoding.js")>(
    "../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => resolveWindowsOemEncodingMock(),
  };
});

beforeEach(() => {
  spawnSync.mockReset();
  resolveWindowsOemEncodingMock.mockReset();
  resolveWindowsOemEncodingMock.mockReturnValue(null);
});

afterEach(() => vi.restoreAllMocks());

const inspectionError = "Effective Scheduled Task service command could not be inspected.";
type RegisteredAction = { type: number; path: string; arguments: string; workingDirectory: string };
function taskAction(pathname: string, args = "", workingDirectory = ""): RegisteredAction {
  return { type: 0, path: pathname, arguments: args, workingDirectory };
}
function mockRegisteredTask(
  actions: RegisteredAction[],
  taskPath = "\\OpenClaw Gateway",
  state = 4,
) {
  spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify({ taskPath, state, actions }) });
}
function effectiveCommand(env: Parameters<typeof readScheduledTaskCommand>[0]) {
  return readScheduledTaskCommand(env, { requireEffective: true, requireLoaded: true });
}
function mockLauncherFiles(files: Map<string, string | Buffer>, fallback?: string) {
  return vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
    if (typeof pathname !== "string") {
      throw new TypeError("Test launcher paths must be strings");
    }
    const content = files.get(pathname) ?? fallback;
    if (content === undefined) {
      throw Object.assign(new Error("Missing test launcher"), { code: "ENOENT" });
    }
    return Buffer.from(content);
  });
}
const backupArguments = [
  "C:\\Node\\node.exe",
  "C:\\OtherInstall\\openclaw.mjs",
  "gateway",
  "--port",
  "19789",
];
const backupCommand = '"C:\\Node\\node.exe" "C:\\OtherInstall\\openclaw.mjs" gateway --port 19789';

describe("readScheduledTaskCommand", () => {
  it("reads a direct registered executable without inventing a launcher", async () => {
    const action = {
      path: "C:\\OpenClaw\\openclaw.exe",
      arguments: 'gateway run --label "literal ^! label"',
    };
    const taskName = "\\Custom\\Gateway";
    mockRegisteredTask([taskAction(action.path, action.arguments, "C:\\OpenClaw")], taskName);
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_WINDOWS_TASK_NAME: taskName };
    const readFile = vi.spyOn(fs, "readFile");
    const onEffectiveExecutable = vi.fn();
    await expect(
      readScheduledTaskCommand(env, {
        requireEffective: true,
        requireLoaded: true,
        onEffectiveExecutable,
      }),
    ).resolves.toEqual({
      programArguments: [action.path, "gateway", "run", "--label", "literal ^! label"],
      workingDirectory: "C:\\OpenClaw",
    });
    expect(onEffectiveExecutable).toHaveBeenCalledExactlyOnceWith(action.path);
    await expect(readScheduledTaskRuntime(env, { requireLoaded: true })).resolves.toMatchObject({
      status: "unknown",
      state: "Running",
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(["environment expansion", "ambiguous quotes"] as const)(
    "does not report a direct executable command with %s",
    async (kind) => {
      const action = taskAction(
        "C:\\Node\\node.exe",
        kind === "environment expansion"
          ? '"%OPENCLAW_HOME%\\openclaw.mjs" gateway'
          : '"C:\\OpenClaw\\openclaw.mjs gateway',
      );
      mockRegisteredTask([action], "\\Custom\\Gateway");
      await expect(
        readScheduledTaskCommand(
          { OPENCLAW_WINDOWS_TASK_NAME: "\\Custom\\Gateway" },
          { requireLoaded: true },
        ),
      ).rejects.toThrow(inspectionError);
    },
  );

  it.each([
    "cmd",
    "cmd executable",
    "wscript executable",
    "current vbs",
    "published vbs",
    "legacy vbs",
  ] as const)(
    "reads the registered custom task action instead of the canonical launcher (%s)",
    async (kind) => {
      const taskName = "\\OpenClaw Gateway Backup";
      const scriptPath = "C:\\Services\\Backup\\gateway.cmd";
      const launcherPath =
        kind === "cmd"
          ? scriptPath
          : kind === "cmd executable"
            ? "C:\\Windows\\System32\\cmd.exe"
            : "C:\\Services\\Backup\\gateway.vbs";
      mockRegisteredTask(
        [
          taskAction(
            kind === "wscript executable" ? "C:\\Windows\\System32\\wscript.exe" : launcherPath,
            kind === "cmd executable"
              ? `/d /s /c ""${scriptPath}""`
              : kind === "wscript executable"
                ? `"${launcherPath}"`
                : "",
            "C:\\Services\\Backup",
          ),
        ],
        taskName,
        3,
      );
      const files = new Map<string, string>([
        [
          scriptPath,
          [
            "@echo off",
            'set "OPENCLAW_PROFILE=default"',
            'set "OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway Backup"',
            'set "OPENCLAW_STATE_DIR=C:\\Services\\Backup"',
            'set "OPENCLAW_CONFIG_PATH=C:\\Services\\Backup\\openclaw.json"',
            'cd /d "C:\\Services\\Backup"',
            `${backupCommand} < NUL`,
          ].join("\r\n"),
        ],
      ]);
      if (kind !== "cmd") {
        files.set(
          launcherPath,
          kind === "current vbs"
            ? buildHiddenLauncherScript({ scriptPath, taskSupervisor: true })
            : kind === "published vbs"
              ? `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`
              : `CreateObject("WScript.Shell").Run """${scriptPath}""", 0, False\r\n`,
        );
      }
      const readFile = mockLauncherFiles(
        files,
        '@echo off\r\n"C:\\Node\\node.exe" "C:\\DefaultInstall\\openclaw.mjs" gateway --port 18789\r\n',
      );
      const captured: string[] = [];
      const onEffectiveExecutable = vi.fn();
      await expect(
        readScheduledTaskCommand(
          { USERPROFILE: "C:\\Users\\test", OPENCLAW_WINDOWS_TASK_NAME: taskName },
          {
            requireEffective: true,
            requireLoaded: true,
            onLauncherContent: (content) => captured.push(content),
            onEffectiveExecutable,
          },
        ),
      ).resolves.toMatchObject({
        programArguments: backupArguments,
        workingDirectory: "C:\\Services\\Backup",
        sourcePath: scriptPath,
        environment: {
          OPENCLAW_PROFILE: "default",
          OPENCLAW_STATE_DIR: "C:\\Services\\Backup",
          OPENCLAW_CONFIG_PATH: "C:\\Services\\Backup\\openclaw.json",
        },
      });
      expect(readFile).toHaveBeenCalledWith(scriptPath);
      expect(onEffectiveExecutable).toHaveBeenCalledExactlyOnceWith(backupArguments[0]);
      expect(captured).toHaveLength(kind === "cmd" || kind === "cmd executable" ? 1 : 2);
      expect(captured.at(-1)).toContain("OtherInstall");
    },
  );

  it.each([
    ["canonical inherited cwd", "C:\\Services\\Gateway", false],
    ["canonical cwd spelling", "c:/services/gateway", false],
    ["authored script cd", "C:\\Services\\Gateway", false, "D:\\Agent Workspace"],
    ["operator inherited cwd", "D:\\Operator", true],
    ["legacy action with native cwd", "C:\\Services\\Gateway", true, undefined, true],
  ] satisfies [string, string, boolean, string?, boolean?][])(
    "keeps runtime pins bound to the script with %s",
    async (_label, nativeCwd, overridden, scriptCwd?: string, directScript?: boolean) => {
      const scriptPath = "C:\\Services\\Gateway\\gateway.cmd";
      const env = { OPENCLAW_TASK_SCRIPT: scriptPath };
      const action = taskAction(
        directScript ? scriptPath : "C:\\Windows\\System32\\cmd.exe",
        directScript ? "" : `/d /s /c ""${scriptPath}""`,
        nativeCwd,
      );
      mockRegisteredTask([action]);
      const script = [
        "@echo off",
        ...(scriptCwd ? [`cd /d "${scriptCwd}"`] : []),
        '"C:\\Node\\node.exe" "C:\\OpenClaw\\openclaw.mjs" gateway --port 18789 < NUL',
      ].join("\r\n");
      const files = new Map([[scriptPath, script]]);
      mockLauncherFiles(files);
      const authored = await readScheduledTaskCommand(env, { requireEffective: true });
      expect(authored).not.toBeNull();
      if (!authored) {
        throw new Error("Missing authored task command");
      }
      const effective = await effectiveCommand(env);
      expect(effective?.workingDirectory).toBe(scriptCwd ?? nativeCwd);
      expect(() => assertDaemonRuntimePinDefinition(authored, effective)).not.toThrow();
      expect(hasGatewayServiceLauncherOverride(effective)).toBe(overridden);
      if (scriptCwd) {
        files.set(scriptPath, script.replace(scriptCwd, "D:\\Changed Workspace"));
        const changed = await effectiveCommand(env);
        expect(() => assertDaemonRuntimePinDefinition(authored, changed)).toThrow(
          "readback differs",
        );
      }
    },
  );

  async function writeScheduledTaskScript(lines: string[], encoding: "utf8" | "gbk" = "utf8") {
    const tmpDir = temporary.make("openclaw-schtasks-test-");
    const env = {
      USERPROFILE: tmpDir,
      OPENCLAW_PROFILE: "default",
    };
    const scriptPath = resolveTaskScriptPath(env);
    const script = ["@echo off", ...lines].join("\r\n");
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    let scriptBytes: Buffer = Buffer.from(script, "utf8");
    if (encoding === "gbk") {
      // Production bytes for a code-page install: marker line + GBK body.
      resolveWindowsOemEncodingMock.mockReturnValueOnce("gbk");
      scriptBytes = encodeWindowsLauncherScript({ format: "cmd", content: script });
    }
    await fs.writeFile(scriptPath, scriptBytes);
    return env;
  }

  it("reads back GBK launchers whose bytes are also valid UTF-8 (隆) without corruption", async () => {
    // GBK "隆" is C2 A1, which UTF-8 accepts as "¡"; the marker keeps readback
    // from sniffing these bytes as UTF-8 and parsing a corrupted path.
    const env = await writeScheduledTaskScript(
      ['cd /d "C:\\Users\\隆\\.openclaw"', "node gateway.js"],
      "gbk",
    );
    expect(await readScheduledTaskCommand(env)).toEqual({
      programArguments: ["node", "gateway.js"],
      workingDirectory: "C:\\Users\\隆\\.openclaw",
      sourcePath: resolveTaskScriptPath(env),
    });
  });

  it("inspects a generated launcher with a trailing-backslash cwd and argument", async () => {
    const workingDirectory = "C:\\Program Files\\OpenClaw\\";
    const programArguments = ["node.exe", "gateway.js", workingDirectory, "SENTINEL-NEXT", ""];
    const env = await writeScheduledTaskScript([
      buildTaskScript({ workingDirectory, programArguments }),
    ]);
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).resolves.toMatchObject({
      workingDirectory,
      programArguments,
    });
  });

  it.each([
    "node gateway.js & node another.js",
    'node gateway.js --msg "a\\" >b" >out',
    'node gateway.js >> "C:\\Logs\\gateway.log"2>&1',
    '"%NODE_EXE%" gateway.js < NUL',
    "node gateway.js !WORKSPACE! < NUL",
    'cd /d "%WORKSPACE%"\r\nnode gateway.js < NUL',
  ])("rejects an ambiguous effective launcher body: %s", async (body) => {
    const env = await writeScheduledTaskScript([body]);
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
      inspectionError,
    );
  });

  function mockWindowsLauncherFiles() {
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: "default" };
    const files = new Map<string, string | Buffer>([
      [resolveTaskScriptPath(env), "@echo off\r\nnode gateway.js\r\n"],
    ]);
    mockLauncherFiles(files);
    return { env, files };
  }

  it.each([false, true])(
    "uses Startup fallback only after proven registration absence (installed: %s)",
    async (startup) => {
      const { env, files } = mockWindowsLauncherFiles();
      if (startup) {
        const startupPath = resolveStartupEntryPaths(env)[0]!;
        files.set(
          startupPath,
          buildStartupLauncherScript({ scriptPath: resolveTaskScriptPath(env) }),
        );
      }
      spawnSync.mockReturnValue({ status: 1, stdout: "-2147024894", stderr: "" });
      const result = await effectiveCommand(env);
      if (startup) {
        expect(result).toMatchObject({
          programArguments: ["node", "gateway.js"],
          sourcePath: resolveTaskScriptPath(env),
        });
      } else {
        expect(result).toBeNull();
      }
      spawnSync.mockReturnValue({ status: 2, stdout: "-2147024891", stderr: "" });
      await expect(effectiveCommand(env)).rejects.toThrow(inspectionError);
    },
  );

  it.each(["legacy vbs", "conflicting wrappers"] as const)(
    "reads the actual generated Startup target (%s)",
    async (kind) => {
      const { env, files } = mockWindowsLauncherFiles();
      files.set(resolveTaskScriptPath(env), "@echo off\r\nnode stale-canonical.js\r\n");
      const scriptPath = "C:\\Services\\Backup\\gateway.cmd";
      const otherPath = "C:\\Services\\Other\\gateway.cmd";
      const startupPaths = resolveStartupEntryPaths(env);
      const writeLauncher = (extension: "cmd" | "vbs", target: string) => {
        const startupPath = startupPaths.find((pathname) => pathname.endsWith(`.${extension}`))!;
        const content =
          extension === "cmd"
            ? buildStartupLauncherScript({ scriptPath: target })
            : kind === "legacy vbs"
              ? `CreateObject("WScript.Shell").Run """${target}""", 0, False\r\n`
              : buildHiddenLauncherScript({ scriptPath: target });
        files.set(startupPath, encodeWindowsLauncherScript({ format: extension, content }));
      };
      if (kind === "conflicting wrappers") {
        writeLauncher("cmd", scriptPath);
      }
      writeLauncher("vbs", kind === "conflicting wrappers" ? otherPath : scriptPath);
      spawnSync.mockReturnValue({ status: 1, stdout: "-2147024894", stderr: "" });
      for (const pathname of [scriptPath, otherPath]) {
        files.set(pathname, `@echo off\r\n${backupCommand}\r\n`);
      }
      const result = effectiveCommand(env);
      if (kind === "conflicting wrappers") {
        await expect(result).rejects.toThrow(inspectionError);
      } else {
        await expect(result).resolves.toMatchObject({
          sourcePath: scriptPath,
          programArguments: backupArguments,
        });
      }
    },
  );

  it.each([
    "multiple actions",
    "action arguments",
    "root-relative action (backslash)",
    "saved name changed",
    "unrecognized vbs",
  ] as const)("rejects strict registered command inspection when %s", async (kind) => {
    const scriptPath = "C:\\Services\\Backup\\gateway.cmd";
    const action = taskAction(
      kind === "unrecognized vbs"
        ? "C:\\Services\\Backup\\gateway.vbs"
        : kind === "root-relative action (backslash)"
          ? "\\gateway.cmd"
          : scriptPath,
      kind === "action arguments" ? "extra" : "",
    );
    mockRegisteredTask(
      kind === "multiple actions" ? [action, action] : [action],
      "\\OpenClaw Gateway Backup",
      3,
    );

    vi.spyOn(fs, "readFile").mockResolvedValue(
      Buffer.from(
        kind === "unrecognized vbs"
          ? `${buildHiddenLauncherScript({ scriptPath })}WScript.Echo "extra executable statement"\r\n`
          : [
              "@echo off",
              `set "OPENCLAW_WINDOWS_TASK_NAME=${kind === "saved name changed" ? "Other Task" : "OpenClaw Gateway Backup"}"`,
              'set "OPENCLAW_PROFILE=default"',
              "node gateway.js",
            ].join("\r\n"),
      ),
    );
    await expect(
      effectiveCommand({
        USERPROFILE: "C:\\Users\\test",
        OPENCLAW_PROFILE: "default",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway Backup",
      }),
    ).rejects.toThrow(inspectionError);
  });

  it.each([
    'gateway.js>>"C:\\Logs\\out log" 2>&1<NUL',
    'gateway.js < NUL >> "%USERPROFILE%\\.openclaw\\logs\\gateway-stdout.log" 2>&1',
  ])("preserves arguments beside quoted or attached operators: %s", async (line) => {
    const env = await writeScheduledTaskScript([`node ${line}`]);
    const result = await readScheduledTaskCommand(env, { requireEffective: true });
    expect(result?.programArguments).toEqual(["node", "gateway.js"]);
  });

  it("preserves unquoted redirect expansion boundaries", async () => {
    const target = "%OPENCLAW_TEST_LOG_PATH%";
    const env = await writeScheduledTaskScript([
      'set "OPENCLAW_TEST_LOG_PATH=C:\\Logs\\gateway output.log"',
      `node gateway.js --port 18789 < NUL >> ${target} 2>&1`,
    ]);
    const result = await readScheduledTaskCommand(env);
    expect(result?.programArguments).toEqual([
      "node",
      "gateway.js",
      "--port",
      "18789",
      "<",
      "NUL",
      ">>",
      target,
      "2>&1",
    ]);
    await expect(readScheduledTaskCommand(env, { requireEffective: true })).rejects.toThrow(
      inspectionError,
    );
  });

  it.each([
    [">out 2>&", [">out", "2>&"]],
    ['--msg "a >b', ["--msg", "a >b"]],
    [">out >>>next", [">out", ">>>next"]],
    [">out 2>&12", [">out", "2>&12"]],
    ['--msg "a\\" >b" >out', ["--msg", 'a" >b', ">out"]],
    ["--port 18789>out", ["--port", "18789>out"]],
  ])("keeps the whole ambiguous launcher command: %s", async (tail, args) => {
    const env = await writeScheduledTaskScript([`node gateway.js ${tail}`]);
    expect((await readScheduledTaskCommand(env))?.programArguments).toEqual([
      "node",
      "gateway.js",
      ...args,
    ]);
  });
});

it("refuses to infer enable policy from a stopped task", async () => {
  spawnSync.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({ state: 3, enabled: "false" }),
    stderr: "",
  });
  await expect(isScheduledTaskEnabled({ env: {} })).rejects.toThrow("enable policy");
});
