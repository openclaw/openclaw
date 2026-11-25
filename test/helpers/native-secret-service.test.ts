import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { finalizeManagedChild } from "../../scripts/lib/managed-child-process.mts";
import { withNativeSecretService } from "./native-secret-service.js";

const owned = vi.hoisted((): { bus?: ChildProcess; root?: string } => ({}));
vi.mock("../../scripts/lib/managed-child-process.mts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../scripts/lib/managed-child-process.mts")>();
  return {
    ...actual,
    loadManagedChildSpawner: () => (command: string, args: string[], options: SpawnOptions) => {
      if (command !== "dbus-daemon") {
        return spawn("/missing/openclaw-secret-service-fixture", [], options);
      }
      const address = args.find((arg) => arg.startsWith("--address="))?.slice(10);
      if (!address || typeof options.cwd !== "string") {
        throw new Error("Missing private bus fixture inputs");
      }
      owned.root = options.cwd;
      owned.bus = spawn(
        process.execPath,
        ["-e", "process.stdout.write(process.argv[1]); process.stdin.resume();", address],
        options,
      );
      return owned.bus;
    },
  };
});

afterEach(async () => {
  if (owned.bus) {
    await finalizeManagedChild(owned.bus, "SIGTERM", {
      platform: process.platform,
      runTaskkill: spawnSync,
    });
  }
});

it.skipIf(process.platform !== "linux")(
  "reports missing keyring executable and joins its already-started private bus",
  async ({ signal }) => {
    await expect(
      withNativeSecretService(signal, async () => {
        throw new Error("Unexpected fixture body");
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const pid = owned.bus?.pid;
    if (!pid || !owned.root) {
      throw new Error("Private bus was not started");
    }
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    await expect(fs.stat(owned.root)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
