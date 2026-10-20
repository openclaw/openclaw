import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { maybeScanExtraGatewayServices } from "../commands/doctor-gateway-services.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import * as doctorServicePolicy from "../commands/doctor-service-repair-policy.js";
import * as configPaths from "../config/paths.js";
import { CORE_HEALTH_CHECKS } from "../flows/doctor-core-checks.js";
import * as gatewayProcesses from "../infra/gateway-processes.js";
import * as portsInspection from "../infra/ports-inspect.js";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import * as probeHosts from "./gateway-service-probe-hosts.js";
import { findExtraGatewayServices } from "./inspect.js";
import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import { resolveStartupEntryPath } from "./schtasks-layout.js";
import * as taskProcesses from "./schtasks-process-snapshot.js";
import * as taskProbe from "./schtasks-state-probe.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const nativePlatform = process.platform;
let root: string;

beforeEach(async () => {
  vi.mocked(spawnSync).mockReset();
  // A UNC spelling also resolves to a real fixture directory on POSIX hosts.
  root = await fs.mkdtemp(
    nativePlatform === "win32"
      ? path.join(os.tmpdir(), "openclaw-startup-")
      : "\\\\openclaw-startup-",
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([]);
  vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({ status: "missing" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});

function environment() {
  return {
    APPDATA: path.join(root, "appdata"),
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway",
    OPENCLAW_PROFILE: "default",
  };
}

async function startup(
  form: "cmd" | "9.2/9.3" | "9.4",
  taskName = "OpenClaw Gateway (rescue)",
  argvProfile = "",
) {
  const env = { ...environment(), OPENCLAW_WINDOWS_TASK_NAME: taskName };
  const startupPath = resolveStartupEntryPath(env, form === "cmd" ? "cmd" : "vbs");
  const scriptPath = path.join(root, path.basename(startupPath), "gateway.cmd");
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.mkdir(path.dirname(startupPath), { recursive: true });
  await fs.writeFile(
    scriptPath,
    [
      "@echo off",
      'set "OPENCLAW_SERVICE_MARKER=openclaw"',
      'set "OPENCLAW_SERVICE_KIND=gateway"',
      `set "OPENCLAW_WINDOWS_TASK_NAME=${taskName}"`,
      `set "OPENCLAW_PROFILE=${taskName === "OpenClaw Gateway" ? "default" : "rescue"}"`,
      `set "OPENCLAW_STATE_DIR=${path.dirname(scriptPath)}"`,
      `"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js"${argvProfile ? ` --profile ${argvProfile}` : ""} gateway --port 19789 < NUL`,
      "",
    ].join("\r\n"),
  );
  const content =
    form === "cmd"
      ? `@echo off\r\nstart "" /min cmd.exe /d /c "${scriptPath}"\r\n`
      : form === "9.4"
        ? `Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("Process")("OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER") = "wscript"\r\nWScript.Quit shell.Run("""${scriptPath}""", 0, True)\r\n`
        : `WScript.Quit CreateObject("WScript.Shell").Run("""${scriptPath}""", 0, True)\r\n`;
  await fs.writeFile(
    startupPath,
    form === "cmd"
      ? Buffer.from(content, "utf8")
      : encodeWindowsLauncherScript({ format: "vbs", content }),
  );
  return { startupPath, scriptPath, taskName };
}

const gatewayCommand =
  '"C:/Node/node.exe" "C:/Applications/openclaw/dist/index.js" gateway --port 19789';
const processSnapshot = (CommandLine = gatewayCommand, ProcessId = 4242) => ({
  ProcessId,
  CommandLine,
});
const nativeResult = (stdout: string, overrides: Partial<SpawnSyncReturns<string>> = {}) => ({
  pid: 1234,
  output: [null, "", ""],
  stdout,
  stderr: "",
  status: 0,
  signal: null,
  ...overrides,
});
const readStartupWithinDeadline = (windowsStartupEntry: string, timeoutMs = 200) =>
  readGatewayServiceState(resolveGatewayService(), {
    env: environment(),
    windowsStartupEntry,
    timeoutMs,
  });
const scheduledTask = (taskPath: string, scriptPath: string) => ({
  taskPath,
  state: 3,
  actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
});

it.each(["cmd", "9.2/9.3"] as const)(
  "discovers a %s Startup launcher without a usable Scheduler",
  async (form) => {
    const legacy = form === "cmd";
    const taskName = legacy ? "OpenClaw Gateway" : "OpenClaw Gateway (rescue)";
    const { startupPath, scriptPath } = await startup(form, taskName);
    if (legacy) {
      await fs.writeFile(scriptPath, '@echo off\r\n"C:/Tools/clawdbot.exe" run\r\n');
    }
    if (!legacy) {
      vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
        throw new Error("unavailable");
      });
    }
    expect(await findExtraGatewayServices(environment(), { deep: true })).toEqual({
      services: [
        expect.objectContaining({
          platform: "win32",
          label: taskName,
          scope: "user",
          marker: legacy ? "clawdbot" : "openclaw",
          legacy,
          windowsStartupEntry: startupPath,
        }),
      ],
      errors: !legacy ? [{ source: "schtasks", message: expect.any(String) }] : [],
    });
    if (legacy) {
      expect(await discoverManagedGatewayBindings(environment())).toEqual([]);
    }
  },
);

it("keeps same-label Startup files bound to their argv profile override", async () => {
  const cmd = await startup("cmd", "Recovery alias", "actual");
  const vbs = await startup("9.4", "Recovery alias", "actual");
  const bindings = await discoverManagedGatewayBindings(environment());
  expect(bindings).toHaveLength(2);
  expect(bindings.map((binding) => binding.windowsStartupEntry)).toEqual(
    expect.arrayContaining([cmd.startupPath, vbs.startupPath]),
  );
  for (const binding of bindings) {
    expect(binding).toMatchObject({ env: { OPENCLAW_PROFILE: "actual" }, scope: "user" });
    expect(binding.env.OPENCLAW_WINDOWS_TASK_NAME).toBeUndefined();
  }
});

it.each(["matching", "foreign"] as const)(
  "reads the exact Startup target without Task Scheduler (%s process)",
  async (processKind) => {
    const { startupPath, scriptPath } = await startup("9.4");
    vi.mocked(taskProbe.probeScheduledTaskState).mockImplementation(() => {
      throw new Error("Task Scheduler must not inspect a Startup file target");
    });
    const foreignCommand =
      '"C:/Node/node.exe" "C:/Other/openclaw/dist/index.js" gateway --port 19789';
    vi.spyOn(taskProcesses, "readWindowsProcessSnapshot").mockReturnValue([
      processKind === "matching" ? processSnapshot() : processSnapshot(foreignCommand, 4343),
    ]);
    if (processKind === "foreign") {
      vi.spyOn(probeHosts, "resolveGatewayServiceProbeHosts").mockResolvedValue(["127.0.0.1"]);
      vi.spyOn(portsInspection, "inspectPortUsage").mockResolvedValue({
        port: 19789,
        status: "busy",
        listeners: [{ pid: 4343, commandLine: foreignCommand }],
        hints: [],
      });
      vi.spyOn(gatewayProcesses, "findVerifiedGatewayListenerPidsOnPortSync").mockReturnValue([
        4343,
      ]);
    }
    const state = await readGatewayServiceState(resolveGatewayService(), {
      env: environment(),
      windowsStartupEntry: startupPath,
      requireEffective: true,
      requireLoadedCommand: true,
    });
    expect(state).toMatchObject({
      command: { sourcePath: scriptPath },
      env: { OPENCLAW_PROFILE: "rescue" },
      runtime:
        processKind === "matching" ? { status: "running", pid: 4242 } : { status: "unknown" },
      running: processKind === "matching",
    });
    expect(taskProbe.probeScheduledTaskState).not.toHaveBeenCalled();
    if (processKind !== "matching") {
      expect(state.runtime?.pid).toBeUndefined();
    }
  },
);

it.each(["process timeout", "absent port", "late absent port"])(
  "honors the Startup inspection deadline: %s",
  async (mode) => {
    const { startupPath } = await startup("9.4");
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const nativeBudgets: number[] = [];
    vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
      const timeout = options?.timeout ?? Infinity;
      nativeBudgets.push(timeout);
      if (mode === "process timeout") {
        now += Math.min(timeout, 250);
        return nativeResult(JSON.stringify([processSnapshot()]), {
          pid: 0,
          status: timeout < 250 ? null : 0,
          signal: timeout < 250 ? "SIGTERM" : null,
          ...(timeout < 250
            ? { error: Object.assign(new Error("Native probe timed out"), { code: "ETIMEDOUT" }) }
            : {}),
        });
      }
      const portRead = args?.join(" ").includes("Get-NetTCPConnection");
      now += portRead ? (mode === "late absent port" ? 170 : 50) : 40;
      return nativeResult(
        portRead ? "0\r\n" : JSON.stringify([processSnapshot("unrelated.exe", 9999)]),
      );
    });
    const state = await readStartupWithinDeadline(startupPath);
    expect(nativeBudgets).toEqual(mode === "process timeout" ? [200] : [200, 160]);
    const expired = mode !== "absent port";
    expect(state).toMatchObject({
      running: false,
      runtime: {
        status: expired ? "unknown" : "stopped",
        ...(expired ? { inspectionFailure: { timeoutMs: 200 } } : {}),
      },
    });
    expect(state.runtime?.pid).toBeUndefined();
    expect(taskProbe.probeScheduledTaskState).not.toHaveBeenCalled();
    if (mode === "process timeout") {
      expect(now).toBe(10_200);
    }
  },
);

it("settles exact Startup inspection when its initial file read stalls", async () => {
  const { startupPath } = await startup("9.4");
  const entered = createDeferred();
  let signal: AbortSignal | undefined;
  vi.mocked(spawnSync).mockReturnValue(nativeResult(JSON.stringify([processSnapshot()])));
  const readFile = fs.readFile.bind(fs);
  vi.spyOn(fs, "readFile").mockImplementation((...args) => {
    if (args[0] === startupPath) {
      const options = args[1];
      signal = typeof options === "object" && options !== null ? options.signal : undefined;
      entered.resolve();
      return new Promise<never>(() => {});
    }
    return readFile(...args);
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const inspection = readStartupWithinDeadline(startupPath);
  await entered.promise;
  await vi.advanceTimersByTimeAsync(200);
  expect(await inspection).toMatchObject({
    running: false,
    runtime: { status: "unknown", inspectionFailure: { timeoutMs: 200 } },
  });
  expect(signal?.aborted).toBe(true);
  expect(spawnSync).not.toHaveBeenCalled();
});

it("reports Startup entries through Doctor when the selected Task exists", async () => {
  const selected = await startup("9.4", "OpenClaw Gateway");
  const sibling = await startup("9.4");
  const task = scheduledTask(selected.taskName, selected.scriptPath);
  vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([task]);
  vi.mocked(taskProbe.probeScheduledTaskState).mockReturnValue({ status: "found", ...task });
  for (const [key, value] of Object.entries(environment())) {
    vi.stubEnv(key, value);
  }
  // Keep the synthetic account eligible; discovery, parsing, and reporting stay real.
  vi.spyOn(configPaths, "isDefaultInstallIdentity").mockReturnValue(true);
  vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
  const notes = vi.spyOn(terminalNote, "note").mockImplementation(() => {});
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const check = CORE_HEALTH_CHECKS.find(({ id }) => id === "core/doctor/gateway-services/extra");
  if (!check) {
    throw new Error("Doctor extra-services check is not registered");
  }
  const context = { mode: "doctor" as const, cfg: {}, runtime, deep: true };
  expect(await check.detect(context)).toEqual(
    [sibling, selected].map((entry) =>
      expect.objectContaining({
        severity: "info",
        target: entry.taskName,
        message: expect.stringContaining(entry.startupPath),
      }),
    ),
  );
  await maybeScanExtraGatewayServices(
    { deep: true },
    runtime,
    createDoctorPrompter({ runtime, options: { nonInteractive: true } }),
  );
  const output = notes.mock.calls.map(([message]) => message).join("\n");
  expect(output).toContain(`Get-Item -LiteralPath '${sibling.startupPath}'`);
  expect(output).toContain(`Get-Item -LiteralPath '${selected.startupPath}'`);
  expect(output).not.toContain("schtasks /Delete");
});

it.each(["launcher", "last task"])(
  "shares the inventory deadline with a late %s",
  async (phase) => {
    const { startupPath, taskName } = await startup("9.4", "Recovery");
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const task = scheduledTask(taskName, startupPath);
    vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
      now += phase === "launcher" ? 59_990 : 50_000;
      return phase === "launcher" ? [] : [task];
    });
    if (phase === "launcher") {
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const contents = await readFile(...args);
        if (args[0] === startupPath) {
          now += 20;
        }
        return contents;
      });
    } else {
      vi.mocked(taskProbe.probeScheduledTaskState).mockImplementation(() => {
        now += 9_999.5;
        return { status: "found", ...task };
      });
    }
    const inventory = await findExtraGatewayServices(environment(), { deep: true });
    if (phase === "launcher") {
      expect(inventory.services).toHaveLength(0);
      expect(inventory.errors).toContainEqual({
        source: startupPath,
        message: "Startup launcher could not be inspected.",
      });
    } else {
      expect(now).toBe(69_999.5);
      expect(inventory).toEqual({
        services: [
          expect.objectContaining({ label: taskName, detail: expect.stringMatching(/^task:/) }),
        ],
        errors: [{ source: "schtasks", message: expect.stringMatching(/deadline expired/) }],
      });
    }
  },
);

it("reports recognizable malformed and unreadable entries without treating unrelated files as Gateways", async () => {
  const env = { ...environment(), OPENCLAW_WINDOWS_TASK_NAME: "Selected Custom" };
  const directory = path.dirname(resolveStartupEntryPath(env));
  await fs.mkdir(directory, { recursive: true });
  const selected = resolveStartupEntryPath(env, "vbs");
  const branded = path.join(directory, "Private Alias.vbs");
  const unreadable = path.join(directory, "OpenClaw Gateway Broken.cmd");
  await fs.writeFile(selected, "unrecognized");
  await fs.writeFile(branded, "node C:\\openclaw\\dist\\entry.js gateway\r\nunrecognized");
  await fs.mkdir(unreadable);
  await fs.writeFile(path.join(directory, "Other.vbs"), "' OpenClaw Gateway\r\nunrecognized");
  const inventory = await findExtraGatewayServices(env, { deep: true });
  expect(inventory.services).toEqual([]);
  expect(inventory.errors.map(({ source }) => source).toSorted()).toEqual(
    ["Selected Custom", selected, branded, unreadable].toSorted(),
  );
});

it.each(["non-directory ENOENT", "unreadable", "unavailable locator"] as const)(
  "reports Startup discovery for %s",
  async (kind) => {
    const env = environment();
    const directory = path.dirname(resolveStartupEntryPath(env));
    if (kind === "non-directory ENOENT") {
      await fs.writeFile(env.APPDATA, "not a directory");
      vi.spyOn(fs, "readdir").mockRejectedValueOnce(
        Object.assign(new Error("scandir failed"), { code: "ENOENT" }),
      );
    } else if (kind === "unreadable") {
      await fs.mkdir(directory, { recursive: true });
      vi.spyOn(fs, "readdir").mockRejectedValueOnce(
        Object.assign(new Error("access denied"), { code: "EACCES" }),
      );
    }
    expect(
      await findExtraGatewayServices(kind === "unavailable locator" ? {} : env, { deep: true }),
    ).toEqual({
      services: [],
      errors: [
        {
          source: kind === "unavailable locator" ? "startup" : directory,
          message: expect.any(String),
        },
      ],
    });
  },
);
