import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as terminalNote from "../../packages/terminal-core/src/note.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { maybeScanExtraGatewayServices } from "../commands/doctor-gateway-services.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import * as doctorServicePolicy from "../commands/doctor-service-repair-policy.js";
import * as configPaths from "../config/paths.js";
import { CORE_HEALTH_CHECKS } from "../flows/doctor-core-checks.js";
import * as gatewayProcesses from "../infra/gateway-processes.js";
import * as portsInspection from "../infra/ports-inspect.js";
import { encodeWindowsLauncherScript } from "../infra/windows-launcher-encoding.js";
import * as probeHosts from "./gateway-service-probe-hosts.js";
import {
  findExtraGatewayServices,
  listManagedOpenClawGatewayServices,
  renderGatewayServiceCleanupHints,
} from "./inspect.js";
import { discoverManagedGatewayBindings } from "./managed-gateway-bindings.js";
import * as taskLayout from "./schtasks-layout.js";
import {
  readScheduledTaskCommand as readTaskCommand,
  resolveStartupEntryPath,
} from "./schtasks-layout.js";
import * as taskProcesses from "./schtasks-process-snapshot.js";
import * as taskProbe from "./schtasks-state-probe.js";
import { readGatewayServiceState, resolveGatewayService } from "./service.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const nativePlatform = process.platform;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
const scheduledTask = (taskPath: string, scriptPath: string) => taskSnapshot(taskPath, scriptPath);
const startupUnknown = {
  running: false,
  runtime: { status: "unknown", inspectionFailure: { timeoutMs: 200 } },
};

describe("Startup entries", () => {
  beforeEach(() => {
    vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([]);
    vi.spyOn(taskProbe, "probeScheduledTaskState").mockReturnValue({ status: "missing" });
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
      expect(state).toMatchObject(
        expired ? startupUnknown : { running: false, runtime: { status: "stopped" } },
      );
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
    expect(await inspection).toMatchObject(startupUnknown);
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

  it("shares the inventory deadline with a late Startup launcher", async () => {
    const { startupPath } = await startup("9.4", "Recovery");
    let now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(taskProbe.listScheduledTasks).mockImplementation(() => {
      now += 59_990;
      return [];
    });
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const contents = await readFile(...args);
      if (args[0] === startupPath) {
        now += 20;
      }
      return contents;
    });
    const inventory = await findExtraGatewayServices(environment(), { deep: true });
    expect(inventory.services).toHaveLength(0);
    expect(inventory.errors).toContainEqual({
      source: startupPath,
      message: "Startup launcher could not be inspected.",
    });
  });

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
});

const account = { USERPROFILE: "C:\\Users\\test" };
const quoteArgv = (argv: string[]) => argv.map((arg) => `"${arg}"`).join(" ");
const gatewayFields = { platform: "win32", marker: "openclaw", legacy: false };
const action = (executable: string, args: string) => ({
  type: 0,
  path: executable,
  arguments: args,
  workingDirectory: "",
});
const taskSnapshot = (
  taskPath: string,
  executable: string | ReturnType<typeof action>[],
  args = "",
) => ({
  taskPath,
  state: 3,
  actions: typeof executable === "string" ? [action(executable, args)] : executable,
});
function mockTask(task: ReturnType<typeof taskSnapshot>, list = true) {
  vi.mocked(spawnSync).mockReturnValueOnce(nativeResult(JSON.stringify(list ? [task] : task)));
  return vi.mocked(spawnSync).mockReturnValue(nativeResult(JSON.stringify(task)));
}

const effective = { requireEffective: true, requireLoaded: true };
const inspectionError = "Effective Scheduled Task service command could not be inspected.";
const registeredScript = (taskName: string) =>
  [
    "@echo off",
    `set "OPENCLAW_WINDOWS_TASK_NAME=${taskName}"`,
    'set "OPENCLAW_PROFILE=rescue"',
    'set "OPENCLAW_SERVICE_MARKER=openclaw"',
    'set "OPENCLAW_SERVICE_KIND=gateway"',
    '"C:\\Node\\node.exe" "C:\\OtherInstall\\openclaw.mjs" gateway run < NUL',
  ].join("\r\n");

it.each(["foreign launcher", "wrapped gateway", "runtime version"])(
  "qualifies complete inventory from %s evidence",
  async (kind) => {
    const version = kind === "runtime version";
    const wrapped = kind === "wrapped gateway";
    const taskName = version
      ? "\\OpenClaw Helper (non-gateway)"
      : "\\Microsoft\\Windows\\Hotpatch\\Monitoring";
    const first = version
      ? "C:\\openclaw-schtasks\\non-gateway\\non-gateway.cmd"
      : "C:\\fixtures\\maintenance.cmd";
    const gateway = "C:\\fixtures\\assistant.bat";
    const task = { ...taskSnapshot(taskName, first), state: version ? 1 : 4 };
    if (wrapped) {
      task.actions.push(
        taskSnapshot(taskName, "C:\\Windows\\System32\\cmd.exe", `/d /c "${gateway}"`).actions[0]!,
      );
    }
    mockTask(task);
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      if (pathname === gateway && wrapped) {
        return Buffer.from(
          '@echo off\r\n"C:\\Node\\node.exe" "C:\\OpenClaw\\openclaw.mjs" --profile rescue gateway run\r\n',
        );
      }
      if (pathname !== first) {
        throw new Error("Unexpected launcher read");
      }
      return Buffer.from(
        version
          ? '@echo off\r\n"C:\\Node\\node.exe" --version\r\n'
          : '@echo off\r\nif "%HOTPATCH_ENABLED%"=="1" call maintenance.exe\r\n',
      );
    });
    const env = { ...account, APPDATA: tempDirs.make("task-startup-") };
    const inventory = version
      ? await findExtraGatewayServices(env, { deep: true })
      : await listManagedOpenClawGatewayServices(env);
    expect(inventory).toEqual({
      services: [],
      errors: wrapped
        ? [{ source: taskName, message: expect.stringContaining("could not be inspected") }]
        : [],
    });
    if (version) {
      await expect(
        readTaskCommand({ ...env, OPENCLAW_WINDOWS_TASK_NAME: taskName }, effective),
      ).rejects.toThrow(inspectionError);
    }
  },
);

it.each(["runtime argv", "launcher metadata"])(
  "binds profiles from %s without admitting another profile",
  async (source) => {
    const taskName = "\\Services\\Recovery";
    const scriptPath = "C:\\Services\\Recovery\\gateway.cmd";
    const argv =
      "C:\\Node\\node.exe --import bootstrap.mjs C:\\OpenClaw\\openclaw.mjs --profile=rescue gateway".split(
        " ",
      );
    const launcher = source === "launcher metadata";
    const env = {
      ...account,
      ...(launcher
        ? { APPDATA: tempDirs.make("registered-task-startup-"), OPENCLAW_PROFILE: "primary" }
        : {}),
    };
    if (launcher) {
      mockTask(taskSnapshot(taskName, scriptPath));
      vi.spyOn(fs, "readFile").mockImplementation(async (pathname) =>
        pathname === scriptPath
          ? Buffer.from(registeredScript(taskName.slice(1)))
          : Promise.reject(new Error("Unexpected launcher read")),
      );
      await expect(findExtraGatewayServices(env, { deep: true })).resolves.toEqual({
        services: [expect.objectContaining({ ...gatewayFields, label: taskName, scope: "system" })],
        errors: [],
      });
    } else {
      mockTask(taskSnapshot(taskName, argv[0]!, quoteArgv(argv.slice(1))), false);
    }
    const selectedEnv = { ...env, OPENCLAW_WINDOWS_TASK_NAME: taskName };
    const options = launcher ? effective : { requireLoaded: true };
    await expect(readTaskCommand(selectedEnv, options)).rejects.toThrow(inspectionError);
    const expected = launcher
      ? { environment: { OPENCLAW_PROFILE: "rescue" } }
      : { programArguments: argv };
    await expect(
      readTaskCommand({ ...selectedEnv, OPENCLAW_PROFILE: "rescue" }, options),
    ).resolves.toMatchObject(expected);
    if (!launcher) {
      await expect(
        readTaskCommand(selectedEnv, { requireLoaded: true, profileScope: "registered" }),
      ).resolves.toMatchObject(expected);
    }
  },
);

it.each([
  { extension: "cmd", exhaustedBy: "query" },
  { extension: "cmd", exhaustedBy: "fractional query" },
  { extension: "cmd", exhaustedBy: "source" },
  { extension: "vbs", exhaustedBy: "launcher" },
])(
  "retains completed $extension discovery when $exhaustedBy exhausts the shared inventory budget",
  async ({ extension, exhaustedBy }) => {
    const task = (name: string, launcherExtension = "cmd") => {
      const scriptPath = `C:\\Tasks\\${name}.cmd`;
      const launcherPath = `C:\\Tasks\\${name}.${launcherExtension}`;
      return {
        scriptPath,
        launcherPath,
        snapshot: taskSnapshot(`\\Services\\${name}`, launcherPath),
      };
    };
    const completed = task("Recovery", extension);
    const slow = task("Slow", extension);
    const trailing = task("Trailing");
    const tasks = [completed, slow, trailing];
    let now = 0;
    const observations: number[] = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(spawnSync).mockImplementation((_command, args, options) => {
      const encoded = args?.[args.indexOf("-EncodedCommand") + 1];
      if (!encoded || typeof options?.timeout !== "number") {
        throw new Error("Unbounded or unrecognized native Scheduler request");
      }
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      const encodedName = /FromBase64String\('([^']*)'\)/.exec(script)?.[1];
      if (encodedName === undefined) {
        throw new Error("Unbounded or unrecognized native Scheduler request");
      }
      const taskName = Buffer.from(encodedName, "base64").toString("utf8");
      observations.push(now);
      const duration =
        taskName === ""
          ? exhaustedBy === "fractional query"
            ? 20_000.5
            : 20_000
          : taskName === slow.snapshot.taskPath && exhaustedBy.includes("query")
            ? 30_000
            : 10_000;
      now += Math.min(duration, options.timeout);
      if (duration > options.timeout) {
        return nativeResult("", {
          status: null,
          error: Object.assign(new Error("Synthetic native query timeout"), { code: "ETIMEDOUT" }),
        });
      }
      const observed = tasks.find((candidate) => candidate.snapshot.taskPath === taskName);
      if (taskName !== "" && !observed) {
        throw new Error("Unexpected task queried by inventory");
      }
      return nativeResult(
        JSON.stringify(
          taskName === "" ? tasks.map((candidate) => candidate.snapshot) : observed?.snapshot,
        ),
      );
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      observations.push(now);
      const observed = tasks.find(
        (candidate) => pathname === candidate.scriptPath || pathname === candidate.launcherPath,
      );
      if (typeof pathname !== "string" || !observed) {
        throw new Error("Unexpected file read in bounded inventory fixture");
      }
      const phase = pathname === observed.scriptPath ? "source" : "launcher";
      if (observed === slow && phase === exhaustedBy) {
        now = 60_000;
      }
      return Buffer.from(
        pathname === observed.scriptPath
          ? registeredScript(observed.snapshot.taskPath)
          : `Set shell = CreateObject("WScript.Shell")\r\nWScript.Quit shell.Run("""${observed.scriptPath}""", 0, True)`,
      );
    });
    const inventory = await findExtraGatewayServices(account, { deep: true });
    expect(now).toBe(exhaustedBy === "fractional query" ? 59_999.5 : 60_000);
    expect(observations.filter((startedAt) => startedAt >= 60_000)).toEqual([]);
    expect(inventory.services).toEqual([
      expect.objectContaining({
        ...gatewayFields,
        label: completed.snapshot.taskPath,
        detail: expect.stringMatching(/^task:/),
      }),
    ]);
    expect(inventory.errors).toHaveLength(1);
    expect(inventory.errors).toContainEqual({
      source: "schtasks",
      message: expect.stringMatching(/deadline expired/),
    });
  },
);

it.each(["launcher", "missing launcher metadata"])(
  "finishes inventory when %s never settles",
  async (phase) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const task = taskSnapshot("\\Services\\Recovery", "C:\\Tasks\\gateway.cmd");
    mockTask(task)
      .mockReturnValueOnce(nativeResult(JSON.stringify(task)))
      .mockReturnValue(nativeResult("-2147024894", { status: 1 }));
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(() => new Promise(() => {}));
    let signal: AbortSignal | undefined;
    vi.spyOn(fs, "readFile").mockImplementation((_path, options) => {
      signal = typeof options === "object" && options !== null ? options.signal : undefined;
      if (phase === "missing launcher metadata") {
        return Promise.reject(
          Object.assign(new Error("Missing launcher fixture"), { code: "ENOENT" }),
        );
      }
      return new Promise(() => {});
    });
    const inventory = findExtraGatewayServices(account, { deep: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await inventory).toEqual({
      services: [],
      errors: [{ source: "schtasks", message: expect.stringMatching(/deadline expired/) }],
    });
    expect(signal?.aborted).toBe(true);
    expect(spawnSync).toHaveBeenCalledTimes(phase === "launcher" ? 2 : 3);
    expect(lstat).toHaveBeenCalledTimes(phase === "launcher" ? 0 : 1);
  },
);

describe("inventory projections", () => {
  let nativeEnv: { APPDATA: string };
  beforeEach(() => {
    nativeEnv = { APPDATA: tempDirs.make("openclaw-windows-inventory-") };
    vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([]);
    vi.spyOn(taskLayout, "readScheduledTaskCommand").mockReset();
  });
  const task = (
    name: string,
    executable: string | ReturnType<typeof action>[] = "C:\\OpenClaw\\openclaw.exe",
    args = "gateway run",
  ) => ({ ...taskSnapshot(name, executable, args), state: null });
  const expectedService = (label: string, legacy = false) =>
    expect.objectContaining({ label, marker: legacy ? "clawdbot" : "openclaw", legacy });

  it("skips Scheduled Task queries unless deep mode is enabled", async () => {
    await expect(findExtraGatewayServices({})).resolves.toEqual({ services: [], errors: [] });
    expect(taskProbe.listScheduledTasks).not.toHaveBeenCalled();
  });

  it("inventories native and launcher-backed Node services without admitting a branded monitor", async () => {
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue([
      task("\\OpenClaw Gateway"),
      task("\\OpenClaw Gateway (dev)", undefined, "gateway run --profile dev"),
      task("\\OpenClaw Gateway Backup"),
      task(
        "\\OpenClaw Node",
        "C:\\Program Files\\nodejs\\node.exe",
        '"C:\\OpenClaw\\dist\\entry.js" node run',
      ),
      task("\\Clawdbot Legacy", "C:\\clawdbot\\clawdbot.exe", "run"),
      task(
        "\\OpenClaw Gateway Monitor",
        "C:\\tools\\monitor.exe",
        "--gateway-url http://127.0.0.1:18789",
      ),
      task("\\OpenClaw CrossAction", [
        action("C:\\OpenClaw\\openclaw.exe", "node run"),
        action("C:\\tools\\helper.exe", "gateway run"),
      ]),
      task("\\Custom Service", "C:\\fixtures\\service.cmd", ""),
    ]);
    vi.mocked(taskLayout.readScheduledTaskCommand).mockResolvedValue({
      programArguments: ["C:\\runtime\\node.exe", "C:\\app\\entry.js", "node", "run"],
      environment: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
    });
    const result = await findExtraGatewayServices(nativeEnv, { deep: true });
    expect(result.errors).toEqual([]);
    expect(result.services).toEqual([
      expectedService("\\OpenClaw Gateway Backup"),
      expectedService("\\OpenClaw Node"),
      expectedService("\\Clawdbot Legacy", true),
      expectedService("\\OpenClaw CrossAction"),
      expectedService("\\Custom Service"),
    ]);
    expect(renderGatewayServiceCleanupHints(result.services).join("\n")).not.toContain("Monitor");
    const managed = await listManagedOpenClawGatewayServices(nativeEnv);
    expect(managed.errors).toEqual([]);
    expect(managed.services.map((service) => service.label)).toEqual([
      "\\OpenClaw Gateway",
      "\\OpenClaw Gateway (dev)",
      "\\OpenClaw Gateway Backup",
    ]);
    for (const service of result.services) {
      expect(service).not.toHaveProperty("windowsProfile");
    }
    for (const service of [...managed.services, ...result.services]) {
      expect(service).not.toHaveProperty("extra");
      expect(service).not.toHaveProperty("managedGateway");
    }
  });

  it.each<[string, taskProbe.ScheduledTaskSnapshot[], string?, string?]>([
    [
      "missing actions",
      ["\\OpenClaw Gateway", "\\Selected Custom"].map((taskPath) => ({
        taskPath,
        state: null,
        actions: undefined,
      })),
      "\\Selected Custom",
    ],
    [
      "missing launchers",
      ["\\OpenClaw Gateway (dev)", "\\Clawdbot Gateway", "\\Custom Service"].map((label) =>
        task(label, "C:\\OpenClaw\\gateway.cmd", ""),
      ),
    ],
    [
      "multiple actions",
      [
        task("\\Mixed Assistant", [
          action("C:\\clawdbot\\clawdbot.exe", "run"),
          action("C:\\OpenClaw\\openclaw.exe", "gateway run"),
        ]),
      ],
      undefined,
      "Multiple Scheduled Task actions",
    ],
  ])("qualifies incomplete inventory: %s", async (name, tasks, selected, message) => {
    vi.mocked(taskProbe.listScheduledTasks).mockReturnValue(tasks);
    const missing = name === "missing launchers";
    if (missing) {
      vi.mocked(taskLayout.readScheduledTaskCommand).mockResolvedValue(null);
    }
    const env = { ...nativeEnv, OPENCLAW_WINDOWS_TASK_NAME: selected };
    const result = selected
      ? await findExtraGatewayServices(env, { deep: true })
      : await listManagedOpenClawGatewayServices(env);
    expect(result).toEqual({
      services: [],
      errors: tasks.map(({ taskPath: source }) => ({
        source,
        message: missing
          ? "Scheduled Task launcher could not be inspected."
          : expect.stringContaining(message ?? "could not be inspected"),
      })),
    });
    expect(renderGatewayServiceCleanupHints(result.services)).toEqual([]);
    if (selected) {
      expect(await listManagedOpenClawGatewayServices(env)).toEqual(result);
    }
  });
});
