import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hasUnjoinedWork } from "../../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../../cli/cli-process-child.test-helpers.js";
import * as sessionCleanup from "../../test-utils/session-state-cleanup.js";
import { withTempHomeCore } from "./temp-home.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const read = (file: string) => fs.readFile(file, "utf8");
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });

it.each(["joined", "kill-error", "exit-timeout"])(
  "cleans a failed CLI fixture only after child cleanup is verified (%s)",
  async (cleanupMode) => {
    const unjoined = cleanupMode !== "joined";
    const ownerRoot = tempDirs.make("sdk-home-owner-");
    const owner = createVitestResourceOwner(ownerRoot);
    const runtimeSource =
      "require('node:fs').writeFileSync(require('node:path').join(process.env.OPENCLAW_STATE_DIR, 'child.txt'), 'child state'); process.stdout.write('ready'); setInterval(() => {}, 1_000);";
    const { HOME, OPENCLAW_STATE_DIR } = process.env;
    const inputFailure = new Error("CLI interaction failed");
    const cleanupSessionState = sessionCleanup.cleanupSessionStateForTest;
    const cleanupSignals: (NodeJS.Signals | null | undefined)[] = [];
    let child: ChildProcessWithoutNullStreams | undefined;
    let home: string | undefined;
    let restoreKill: (() => void) | undefined;
    const cleanup = vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");
    cleanup.mockImplementation(async (options) => {
      cleanupSignals.push(child?.signalCode);
      await cleanupSessionState(options);
    });
    try {
      const failure = await withTempHomeCore(
        async (fixtureHome) => {
          home = fixtureHome;
          await fs.writeFile(path.join(fixtureHome, "owned.txt"), "retain while live");
          return runCliProcessChild({
            nodeArgs: ["-e", runtimeSource],
            env: process.env,
            interact: async (runningChild) => {
              child = runningChild;
              await once(runningChild.stdout, "data");
              if (unjoined) {
                const kill = vi.spyOn(runningChild, "kill").mockImplementation(() => {
                  if (cleanupMode === "exit-timeout") {
                    return true;
                  }
                  throw new Error("cleanup kill failed");
                });
                restoreKill = () => kill.mockRestore();
              }
              throw inputFailure;
            },
          });
        },
        {
          prefix: path.join(path.basename(ownerRoot), "home-"),
          ...(unjoined ? { env: { TMPDIR: ownerRoot, TMP: ownerRoot, TEMP: ownerRoot } } : {}),
        },
      ).catch((error: unknown) => error);

      expect(hasUnjoinedWork(failure)).toBe(unjoined);
      expect(process.env.HOME).toBe(HOME);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(OPENCLAW_STATE_DIR);
      if (unjoined) {
        expect(failure).toMatchObject({ cause: inputFailure });
        expect(child).toMatchObject({ exitCode: null, signalCode: null });
        expect(cleanup).not.toHaveBeenCalled();
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        if (cleanupMode === "exit-timeout") {
          expect(String(failure)).toContain("did not exit within 5000ms after SIGKILL");
        }
        expect(await read(path.join(home!, "owned.txt"))).toBe("retain while live");
        expect(await read(path.join(home!, ".openclaw", "child.txt"))).toBe("child state");
      } else {
        expect(failure).toBe(inputFailure);
        expect(cleanupSignals).toEqual(["SIGKILL"]);
        expect(() => owner.assertReleased()).not.toThrow();
        await expectMissing(home!);
      }
    } finally {
      cleanup.mockRestore();
      restoreKill?.();
      if (child) {
        await stopChildProcess(child, 1_000);
      }
      if (home) {
        await cleanupSessionState({ stateDir: path.join(home, ".openclaw") });
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  },
);
