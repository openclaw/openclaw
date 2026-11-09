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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function expectStateDirEnvRestored(
  prev: string | undefined,
  dirs: { stateDir: string; tempRoot: string },
) {
  expect(process.env.OPENCLAW_STATE_DIR).toBe(prev);
  await expect(fs.stat(dirs.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(dirs.tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("state-dir-env helpers", () => {
  it("set/snapshot/restore round-trips OPENCLAW_STATE_DIR", () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    const snapshot = snapshotStateDirEnv();

    try {
      setStateDirEnv("/tmp/openclaw-state-dir-test");
      expect(process.env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-state-dir-test");

      restoreStateDirEnv(snapshot);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(prev);
    } finally {
      snapshot.restore();
    }
  });

  it.each([false, true])(
    "withStateDirEnv shares one canonical state root and cleans up (aliased temp=%s)",
    async (aliased) => {
      const prev = process.env.OPENCLAW_STATE_DIR;

      const parent = tempDirs.make("openclaw-state-dir-parent-");
      const actualParent = path.join(parent, "actual");
      await fs.mkdir(actualParent);
      const tempParent = aliased ? path.join(parent, "alias") : actualParent;
      if (aliased) {
        const linkType = process.platform === "win32" ? "junction" : "dir";
        await fs.symlink(actualParent, tempParent, linkType);
      }
      const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(tempParent);

      let captured = { tempRoot: "", stateDir: "" };
      try {
        await withStateDirEnv("openclaw-state-dir-env-", async (dirs) => {
          captured = dirs;
          const { stateDir } = dirs;
          expect(stateDir).toBe(await fs.realpath(stateDir));
          expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
          await fs.writeFile(path.join(stateDir, "probe.txt"), "ok", "utf8");
        });
      } finally {
        tmpdir.mockRestore();
      }

      await expectStateDirEnvRestored(prev, captured);
    },
  );

  it("withStateDirEnv restores env and cleans temp root when callback throws", async () => {
    const prev = process.env.OPENCLAW_STATE_DIR;

    let captured = { tempRoot: "", stateDir: "" };
    await expect(
      withStateDirEnv("openclaw-state-dir-env-", async (dirs) => {
        captured = dirs;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expectStateDirEnvRestored(prev, captured);
  });
});
