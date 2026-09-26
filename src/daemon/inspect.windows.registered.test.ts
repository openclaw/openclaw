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
  const env = {
    USERPROFILE: "C:\\Users\\test",
    APPDATA: tempDirs.make("registered-task-startup-"),
    OPENCLAW_PROFILE: profile,
  };
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
