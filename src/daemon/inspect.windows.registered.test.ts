import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { findExtraGatewayServices } from "./inspect.js";
import { readScheduledTaskCommand } from "./schtasks-layout.js";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));
beforeEach(() => spawnSync.mockReset());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("excludes a static non-Gateway runtime command without admitting its missing profile", async () => {
  const taskName = "\\OpenClaw Helper (non-gateway)";
  const scriptPath = "C:\\openclaw-schtasks\\non-gateway\\non-gateway.cmd";
  const task = {
    taskPath: taskName,
    state: 1,
    actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
  };
  spawnSync
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([task]) })
    .mockReturnValue({ status: 0, stdout: JSON.stringify(task) });
  const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
    if (pathname !== scriptPath) {
      throw new Error("Unexpected file read in unrelated-task inventory fixture");
    }
    return Buffer.from('@echo off\r\n"C:\\Node\\node.exe" --version\r\n');
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  const env = {
    USERPROFILE: "C:\\Users\\test",
    APPDATA: tempDirs.make("unrelated-task-startup-"),
  };
  try {
    await expect(findExtraGatewayServices(env, { deep: true })).resolves.toEqual({
      services: [],
      errors: [],
    });
    await expect(
      readScheduledTaskCommand(
        { ...env, OPENCLAW_WINDOWS_TASK_NAME: taskName },
        { requireEffective: true, requireLoaded: true },
      ),
    ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
  } finally {
    readFile.mockRestore();
    Object.defineProperty(process, "platform", platform);
  }
});

it.each(["direct executable", "Node runtime", "CMD launcher"])(
  "binds the selected profile to effective argv for a %s",
  async (kind) => {
    const taskName = "\\Services\\Recovery";
    const scriptPath = "C:\\Services\\Recovery\\gateway.cmd";
    const direct = kind === "direct executable";
    const launcher = kind === "CMD launcher";
    const argv = direct
      ? ["C:\\OpenClaw\\openclaw.exe", "--profile=rescue", "gateway"]
      : [
          "C:\\Node\\node.exe",
          "--import",
          "bootstrap.mjs",
          "C:\\OpenClaw\\openclaw.mjs",
          "--profile=rescue",
          "gateway",
        ];
    const task = {
      taskPath: taskName,
      state: 3,
      actions: [
        {
          type: 0,
          path: launcher ? scriptPath : argv[0],
          arguments: launcher
            ? ""
            : argv
                .slice(1)
                .map((arg) => `"${arg}"`)
                .join(" "),
          workingDirectory: "",
        },
      ],
    };
    spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(task) });
    const readFile = vi
      .spyOn(fs, "readFile")
      .mockResolvedValue(
        Buffer.from(
          [
            "@echo off",
            'set "OPENCLAW_PROFILE=default"',
            argv.map((arg) => `"${arg}"`).join(" "),
          ].join("\r\n"),
        ),
      );
    const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_WINDOWS_TASK_NAME: taskName };
    try {
      await expect(readScheduledTaskCommand(env, { requireLoaded: true })).rejects.toThrow(
        "Effective Scheduled Task service command could not be inspected.",
      );
      for (const options of [
        { env: { ...env, OPENCLAW_PROFILE: "rescue" }, profileScope: undefined },
        { env, profileScope: "registered" as const },
      ]) {
        await expect(
          readScheduledTaskCommand(options.env, {
            requireLoaded: true,
            profileScope: options.profileScope,
          }),
        ).resolves.toMatchObject({
          programArguments: argv,
          ...(launcher ? { environment: { OPENCLAW_PROFILE: "default" } } : {}),
        });
      }
    } finally {
      readFile.mockRestore();
    }
  },
);

it.each([
  ["implicit default", undefined],
  ["explicit default", "default"],
  ["another named profile", "primary"],
])("inventories a profiled custom task without admitting it for %s", async (_name, profile) => {
  const taskName = "\\Services\\Recovery";
  const scriptPath = "C:\\Services\\Recovery\\gateway.cmd";
  const task = {
    taskPath: taskName,
    state: 3,
    actions: [{ type: 0, path: scriptPath, arguments: "", workingDirectory: "" }],
  };
  spawnSync
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([task]) })
    .mockReturnValue({ status: 0, stdout: JSON.stringify(task) });
  const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
    if (pathname !== scriptPath) {
      throw new Error("Unexpected file read in registered-task inventory fixture");
    }
    return Buffer.from(
      [
        "@echo off",
        'set "OPENCLAW_WINDOWS_TASK_NAME=Services\\Recovery"',
        'set "OPENCLAW_PROFILE=rescue"',
        'set "OPENCLAW_SERVICE_MARKER=openclaw"',
        'set "OPENCLAW_SERVICE_KIND=gateway"',
        '"C:\\Node\\node.exe" "C:\\OtherInstall\\openclaw.mjs" gateway run < NUL',
      ].join("\r\n"),
    );
  });
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  const env = { USERPROFILE: "C:\\Users\\test", OPENCLAW_PROFILE: profile };
  try {
    await expect(findExtraGatewayServices(env, { deep: true })).resolves.toEqual({
      services: [
        expect.objectContaining({
          platform: "win32",
          label: taskName,
          scope: "system",
          marker: "openclaw",
          legacy: false,
        }),
      ],
      errors: [],
    });
    await expect(
      readScheduledTaskCommand(
        { ...env, OPENCLAW_WINDOWS_TASK_NAME: taskName },
        { requireEffective: true, requireLoaded: true },
      ),
    ).rejects.toThrow("Effective Scheduled Task service command could not be inspected.");
    await expect(
      readScheduledTaskCommand(
        { ...env, OPENCLAW_WINDOWS_TASK_NAME: taskName, OPENCLAW_PROFILE: "rescue" },
        { requireEffective: true, requireLoaded: true },
      ),
    ).resolves.toMatchObject({ environment: { OPENCLAW_PROFILE: "rescue" } });
  } finally {
    readFile.mockRestore();
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

it.each([
  { extension: "cmd", exhaustedBy: "query" },
  { extension: "vbs", exhaustedBy: "query" },
  { extension: "cmd", exhaustedBy: "fractional query" },
  { extension: "cmd", exhaustedBy: "source" },
  { extension: "vbs", exhaustedBy: "launcher" },
  { extension: "cmd", exhaustedBy: "source revalidation" },
  { extension: "vbs", exhaustedBy: "launcher revalidation" },
])(
  "retains completed $extension discovery when $exhaustedBy exhausts the shared inventory budget",
  async ({ extension, exhaustedBy }) => {
    const task = (name: string, launcherExtension = "cmd") => {
      const scriptPath = `C:\\Tasks\\${name}.cmd`;
      const launcherPath = `C:\\Tasks\\${name}.${launcherExtension}`;
      const taskPath = `\\Services\\${name}`;
      return {
        scriptPath,
        launcherPath,
        snapshot: {
          taskPath,
          state: 3,
          actions: [{ type: 0, path: launcherPath, arguments: "", workingDirectory: "" }],
        },
        script: [
          "@echo off",
          `set "OPENCLAW_WINDOWS_TASK_NAME=${taskPath}"`,
          'set "OPENCLAW_PROFILE=rescue"',
          'set "OPENCLAW_SERVICE_MARKER=openclaw"',
          'set "OPENCLAW_SERVICE_KIND=gateway"',
          '"C:\\Node\\node.exe" "C:\\OtherInstall\\openclaw.mjs" gateway run < NUL',
        ].join("\r\n"),
      };
    };
    const completed = task("Recovery", extension);
    const slow = task("Slow", extension);
    const trailing = task("Trailing");
    const tasks = [completed, slow, trailing];
    let now = 0;
    const observations: Array<{ taskName: string; startedAt: number }> = [];
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    spawnSync.mockImplementation((_command, args, options) => {
      const encoded = args[args.indexOf("-EncodedCommand") + 1];
      const script = Buffer.from(encoded, "base64").toString("utf16le");
      const encodedName = /FromBase64String\('([^']*)'\)/.exec(script)?.[1];
      if (encodedName === undefined || typeof options?.timeout !== "number") {
        throw new Error("Unbounded or unrecognized native Scheduler request");
      }
      const taskName = Buffer.from(encodedName, "base64").toString("utf8");
      observations.push({ taskName, startedAt: now });
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
    const fileObservations: number[] = [];
    const reads = new Map<string, number>();
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (pathname) => {
      fileObservations.push(now);
      const observed = tasks.find(
        (candidate) => pathname === candidate.scriptPath || pathname === candidate.launcherPath,
      );
      if (typeof pathname !== "string" || !observed) {
        throw new Error("Unexpected file read in bounded inventory fixture");
      }
      const read = (reads.get(pathname) ?? 0) + 1;
      reads.set(pathname, read);
      if (observed === slow) {
        const phase = pathname === slow.scriptPath ? "source" : "launcher";
        if (`${phase}${read === 2 ? " revalidation" : ""}` === exhaustedBy) {
          now = 60_000;
        }
      }
      return Buffer.from(
        pathname === observed.scriptPath
          ? observed.script
          : `Set shell = CreateObject("WScript.Shell")\r\nWScript.Quit shell.Run("""${observed.scriptPath}""", 0, True)`,
      );
    });
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const inventory = await findExtraGatewayServices(
        { USERPROFILE: "C:\\Users\\test" },
        { deep: true },
      );
      expect(now).toBe(exhaustedBy === "fractional query" ? 59_999.5 : 60_000);
      expect(observations.filter(({ startedAt }) => startedAt >= 60_000)).toEqual([]);
      expect(fileObservations.filter((startedAt) => startedAt >= 60_000)).toEqual([]);
      expect(inventory.services).toEqual([
        expect.objectContaining({
          label: completed.snapshot.taskPath,
          platform: "win32",
          marker: "openclaw",
          legacy: false,
        }),
      ]);
      expect(inventory.errors).toEqual(
        expect.arrayContaining([{ source: "schtasks", message: expect.stringMatching(/\S/) }]),
      );
    } finally {
      spawnSync.mockReset();
      clock.mockRestore();
      readFile.mockRestore();
      Object.defineProperty(process, "platform", originalPlatform);
    }
  },
);

it.each(["launcher", "missing launcher metadata"])(
  "finishes inventory when %s never settles",
  async (phase) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const task = {
      taskPath: "\\Services\\Recovery",
      state: 3,
      actions: [{ type: 0, path: "C:\\Tasks\\gateway.cmd", arguments: "", workingDirectory: "" }],
    };
    spawnSync
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([task]) })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(task) })
      .mockReturnValue({ status: 1, stdout: "-2147024894" });
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(() => new Promise(() => {}));
    let signal: AbortSignal | undefined;
    const readFile = vi.spyOn(fs, "readFile").mockImplementation((_path, options) => {
      signal = typeof options === "object" && options !== null ? options.signal : undefined;
      if (phase === "missing launcher metadata") {
        return Promise.reject(
          Object.assign(new Error("Missing launcher fixture"), { code: "ENOENT" }),
        );
      }
      return new Promise(() => {});
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      let result: Awaited<ReturnType<typeof findExtraGatewayServices>> | undefined;
      const inventory = findExtraGatewayServices(
        { USERPROFILE: "C:\\Users\\test" },
        { deep: true },
      ).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(result).toEqual({
        services: [],
        errors: [{ source: "schtasks", message: expect.stringMatching(/deadline expired/) }],
      });
      expect(signal?.aborted).toBe(true);
      expect(spawnSync).toHaveBeenCalledTimes(phase === "launcher" ? 2 : 3);
      expect(lstat).toHaveBeenCalledTimes(phase === "launcher" ? 0 : 1);
      await inventory;
    } finally {
      spawnSync.mockReset();
      readFile.mockRestore();
      lstat.mockRestore();
      Object.defineProperty(process, "platform", platform);
      vi.useRealTimers();
    }
  },
);
