import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runImmutableBuild } from "./update-immutable-build.js";
import { immutableLayout } from "./update-immutable-layout.test-support.js";
import type { CommandRunner } from "./update-runner-types.js";

const mocks = vi.hoisted(() => ({ command: vi.fn<CommandRunner>() }));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.command,
}));
vi.mock("../daemon/systemd-cgroup.js", () => ({ isSystemdControlGroupEmpty: async () => true }));

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  mocks.command.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])("builds in private staging (isolated account: %s)", async (isolated) => {
  const parent = dirs.make("immutable-operator-build-");
  const descriptor = immutableLayout(parent, {
    sha: "a".repeat(40),
    buildDigest: "c".repeat(64),
    unit: "fixture.service",
    account: "fixture",
  });
  const operatorUid = process.geteuid?.();
  vi.stubEnv("PATH", "/root/.local/bin:/usr/bin:/bin");
  const stage = path.join(parent, "build");
  await fs.mkdir(stage, { mode: 0o700 });
  if (isolated) {
    descriptor.build = {
      account: "builder",
      uid: 1001,
      gid: 1001,
      toolchainPath: "/usr/bin",
      resources: { memoryMaxBytes: 1024, tasksMax: 16, buildFreeBytes: 1, runtimeFreeBytes: 1 },
    };
  }
  const access = fs.access;
  vi.spyOn(fs, "access").mockImplementation((file, mode) =>
    file === "/sys/fs/cgroup/cgroup.controllers" ? Promise.resolve() : access(file, mode),
  );
  const chown = vi.spyOn(fs, "chown").mockResolvedValue();
  mocks.command.mockImplementation(async (argv) => {
    if (argv[0] === "/usr/bin/id") {
      return { code: 0, stdout: argv.at(-1) === "builder" ? "1001" : "1002", stderr: "" };
    }
    if (argv[0] === "/usr/bin/systemd-run") {
      expect((await fs.stat(stage)).mode & 0o077).toBe(0);
      await fs.mkdir(path.join(stage, "generation"));
      await fs.writeFile(path.join(stage, "generation", "artifact"), "candidate");
    }
    return { code: 0, stdout: "", stderr: "" };
  });

  await runImmutableBuild({
    descriptor,
    stage,
    sha: "b".repeat(40),
    timeoutMs: 1000,
    assertCurrent: () => {},
  });

  expect(await fs.readFile(path.join(stage, "generation", "artifact"), "utf8")).toBe("candidate");
  expect(chown.mock.calls.length).toBe(isolated ? 3 : 0);
  const launch = mocks.command.mock.calls.find(([argv]) => argv[0] === "/usr/bin/systemd-run");
  expect(launch?.[0]).toContain(`--property=User=${isolated ? 1001 : operatorUid}`);
  expect(launch?.[0]).toContain(
    `--property=InaccessiblePaths=${isolated ? "-/root " : ""}${descriptor.service.stateDir} ${descriptor.service.configPath}`,
  );
  expect(launch?.[0]).toContain(
    `PATH=${isolated ? "/usr/bin:/usr/bin:/bin" : "/root/.local/bin:/usr/bin:/bin"}`,
  );
  expect(launch?.[0]).toContain(`--property=ReadWritePaths=${stage}`);
  expect(launch?.[0]).toContain(`HOME=${stage}/home`);
  expect(mocks.command.mock.calls.at(-1)?.[0].slice(0, 2)).toEqual(["/usr/bin/systemctl", "stop"]);
});
