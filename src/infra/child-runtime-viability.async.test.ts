import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../process/spawn-broker/host.js";
import { supportsSpawnBrokerCommandTransport } from "../process/spawn-broker/pipe.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import {
  formatChildRuntimeSpawnWarning,
  prepareChildRuntimeViability,
} from "./child-runtime-viability.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const directories = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(!supportsSpawnBrokerCommandTransport()).each(["removed", "loader failure"])(
  "probes through the broker on every observation and detects a runtime %s",
  async (failure) => {
    const directory = directories.make("openclaw-runtime-broker-");
    const execPath = path.join(directory, "node");
    await fs.symlink(process.execPath, execPath);
    const broker = createSpawnBrokerHost();
    try {
      await broker.ready();
      const probes = vi.spyOn(broker, "spawnExeca");
      vi.mocked(execFile).mockClear();
      vi.mocked(spawn).mockClear();
      vi.mocked(spawnSync).mockClear();
      await runWithSpawnBroker(broker, async () => {
        for (let observation = 0; observation < 2; observation++) {
          expect((await prepareChildRuntimeViability({ execPath })).publish()).toEqual({
            execPath,
            available: true,
          });
        }
        if (failure === "removed") {
          await broker.close();
        }
        await fs.unlink(execPath);
        if (failure === "loader failure") {
          await fs.writeFile(
            execPath,
            "#!/bin/sh\necho 'node: error while loading shared libraries: libfixture.so' >&2\nexit 127\n",
            { mode: 0o700 },
          );
        }
        expect((await prepareChildRuntimeViability({ execPath })).publish()).toEqual({
          execPath,
          available: false,
        });
      });
      expect(execFile).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
      expect(probes).toHaveBeenCalledTimes(3);
    } finally {
      await broker.close();
    }
  },
);

it("diagnoses a failed launch without synchronous runtime filesystem checks", async () => {
  const error = Object.assign(new Error("synthetic child launch failure"), {
    code: "EACCES",
    path: process.execPath,
  });
  let calls;
  let warning;
  {
    using filesystem = observeMainThreadFs();
    expect((await prepareChildRuntimeViability()).publish().available).toBe(true);
    warning = await formatChildRuntimeSpawnWarning(error);
    calls = filesystem.stacks().filter(({ stack }) => stack.includes("child-runtime-viability"));
  }
  expect(warning).toBeUndefined();
  expect(error).toMatchObject({ code: "EACCES", path: process.execPath });
  expect(calls).toEqual([]);
});
