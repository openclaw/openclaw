import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  findExtraGatewayServices as findExtras,
  listManagedOpenClawGatewayServices,
} from "./inspect.js";
import { readScheduledTaskCommand as readTaskCommand } from "./schtasks-layout.js";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  spawnSync.mockReset();
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Object.defineProperty(process, "platform", originalPlatform);
});

const account = { USERPROFILE: "C:\\Users\\test" };
const quoteArgv = (argv: string[]) => argv.map((arg) => `"${arg}"`).join(" ");
const gatewayFields = { platform: "win32", marker: "openclaw", legacy: false };
const taskSnapshot = (taskPath: string, path: string, args = "") => ({
  taskPath,
  state: 3,
  actions: [{ type: 0, path, arguments: args, workingDirectory: "" }],
});
function mockTask(task: ReturnType<typeof taskSnapshot>, list = true) {
  spawnSync.mockReturnValueOnce({ status: 0, stdout: JSON.stringify(list ? [task] : task) });
  return spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(task) });
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
      ? await findExtras(env, { deep: true })
      : await listManagedOpenClawGatewayServices(env, { requireComplete: true });
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
      await expect(findExtras(env, { deep: true })).resolves.toEqual({
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
    spawnSync.mockImplementation((_command, args, options) => {
      const encoded = args[args.indexOf("-EncodedCommand") + 1];
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      const encodedName = /FromBase64String\('([^']*)'\)/.exec(script)?.[1];
      if (encodedName === undefined || typeof options?.timeout !== "number") {
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
        return {
          status: null,
          stdout: "",
          error: Object.assign(new Error("Synthetic native query timeout"), { code: "ETIMEDOUT" }),
        };
      }
      const observed = tasks.find((candidate) => candidate.snapshot.taskPath === taskName);
      if (taskName !== "" && !observed) {
        throw new Error("Unexpected task queried by inventory");
      }
      return {
        status: 0,
        stdout: JSON.stringify(
          taskName === "" ? tasks.map((candidate) => candidate.snapshot) : observed?.snapshot,
        ),
      };
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
    const inventory = await findExtras(account, { deep: true });
    expect(now).toBe(exhaustedBy === "fractional query" ? 59_999.5 : 60_000);
    expect(observations.filter((startedAt) => startedAt >= 60_000)).toEqual([]);
    expect(inventory.services).toEqual([
      expect.objectContaining({ ...gatewayFields, label: completed.snapshot.taskPath }),
    ]);
    expect(inventory.errors).toContainEqual({
      source: "schtasks",
      message: expect.stringMatching(/\S/),
    });
  },
);

it.each(["launcher", "missing launcher metadata"])(
  "finishes inventory when %s never settles",
  async (phase) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const task = taskSnapshot("\\Services\\Recovery", "C:\\Tasks\\gateway.cmd");
    mockTask(task)
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(task) })
      .mockReturnValue({ status: 1, stdout: "-2147024894" });
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
    const inventory = findExtras(account, { deep: true });
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
