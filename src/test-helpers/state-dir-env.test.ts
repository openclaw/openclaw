// State dir environment tests cover isolated state directory env helpers.
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
  withStateDirEnv,
} from "./state-dir-env.js";

type EnvSnapshot = {
  openclaw?: string;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function snapshotCurrentStateDirVars(): EnvSnapshot {
  return {
    openclaw: process.env.OPENCLAW_STATE_DIR,
  };
}

function expectStateDirVars(snapshot: EnvSnapshot) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(snapshot.openclaw);
}

async function expectPathMissing(filePath: string) {
  try {
    await fs.stat(filePath);
    throw new Error(`Expected ${filePath} to be missing`);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  }
}

async function expectStateDirEnvRestored(params: {
  prev: EnvSnapshot;
  capturedStateDir: string;
  capturedTempRoot: string;
}) {
  expectStateDirVars(params.prev);
  await expectPathMissing(params.capturedStateDir);
  await expectPathMissing(params.capturedTempRoot);
}

describe("state-dir-env helpers", () => {
  it("set/snapshot/restore round-trips OPENCLAW_STATE_DIR", () => {
    const prev = snapshotCurrentStateDirVars();
    const snapshot = snapshotStateDirEnv();

    setStateDirEnv("/tmp/openclaw-state-dir-test");
    expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-state-dir-test");

    restoreStateDirEnv(snapshot);
    expectStateDirVars(prev);
  });

  it.each([false, true])(
    "withStateDirEnv shares one canonical state root and cleans up (aliased temp=%s)",
    async (aliased) => {
      const prev = snapshotCurrentStateDirVars();

      const parent = tempDirs.make("openclaw-state-dir-parent-");
      const actualParent = path.join(parent, "actual");
      await fs.mkdir(actualParent);
      const tempParent = aliased ? path.join(parent, "alias") : actualParent;
      if (aliased) {
        await fs.symlink(
          actualParent,
          tempParent,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(tempParent);

      let capturedTempRoot = "";
      let capturedStateDir = "";
      try {
        await withStateDirEnv("openclaw-state-dir-env-", async ({ tempRoot, stateDir }) => {
          capturedTempRoot = tempRoot;
          capturedStateDir = stateDir;
          expect(stateDir).toBe(await fs.realpath(stateDir));
          expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
          await fs.writeFile(path.join(stateDir, "probe.txt"), "ok", "utf8");
        });
      } finally {
        tmpdir.mockRestore();
      }

      await expectStateDirEnvRestored({ prev, capturedStateDir, capturedTempRoot });
    },
  );

  it("withStateDirEnv restores env and cleans temp root when callback throws", async () => {
    const prev = snapshotCurrentStateDirVars();

    let capturedTempRoot = "";
    let capturedStateDir = "";
    await expect(
      withStateDirEnv("openclaw-state-dir-env-", async ({ tempRoot, stateDir }) => {
        capturedTempRoot = tempRoot;
        capturedStateDir = stateDir;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expectStateDirEnvRestored({ prev, capturedStateDir, capturedTempRoot });
  });
});
