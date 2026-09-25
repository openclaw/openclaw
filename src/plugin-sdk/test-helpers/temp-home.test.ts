import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { hasUnjoinedWork } from "../../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../../cli/cli-process-child.test-helpers.js";
import * as sessionCleanup from "../../test-utils/session-state-cleanup.js";
import { withTempHomeCore } from "./temp-home.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("shared temp-home root acquisition", () => {
  it.each(["joined", "kill-error", "exit-timeout"])(
    "cleans a failed CLI fixture only after child cleanup is verified (%s)",
    async (cleanupMode) => {
      const unjoined = cleanupMode !== "joined";
      const ownerRoot = tempDirs.make("sdk-home-owner-");
      const owner = createVitestResourceOwner(ownerRoot);
      const runtime = createFixtureLifetime(ownerRoot);
      const runtimeRoot = runtime.createTempDir("runtime-");
      const runtimePath = path.join(runtimeRoot, "entry.cjs");
      const runtimeSource =
        "require('node:fs').writeFileSync(require('node:path').join(process.env.OPENCLAW_STATE_DIR, 'child.txt'), 'child state'); process.stdout.write('ready'); setInterval(() => {}, 1_000);";
      await fs.writeFile(runtimePath, runtimeSource);
      const cleanupRuntime = () => runtime.cleanup();
      onTestFinished(cleanupRuntime);
      const originalHome = process.env.HOME;
      const originalStateDir = process.env.OPENCLAW_STATE_DIR;
      const inputFailure = new Error("CLI interaction failed");
      const cleanupSessionState = sessionCleanup.cleanupSessionStateForTest;
      const cleanup = vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");
      const cleanupSignals: (NodeJS.Signals | null | undefined)[] = [];
      let child: ChildProcessWithoutNullStreams | undefined;
      let home: string | undefined;
      let restoreKill: (() => void) | undefined;
      cleanup.mockImplementation(async (options) => {
        cleanupSignals.push(child?.signalCode);
        await cleanupSessionState(options);
      });
      try {
        const failure = await withTempHomeCore(
          async (fixtureHome) => {
            home = fixtureHome;
            await fs.writeFile(path.join(fixtureHome, "owned.txt"), "retain while live");
            return runtime.track(
              runCliProcessChild({
                nodeArgs: [runtimePath],
                env: process.env,
                interact: async (runningChild) => {
                  child = runningChild;
                  await once(runningChild.stdout, "data");
                  if (unjoined) {
                    const kill = runningChild.kill.bind(runningChild);
                    restoreKill = () => {
                      runningChild.kill = kill;
                    };
                    runningChild.kill = () => {
                      if (cleanupMode === "exit-timeout") {
                        return true;
                      }
                      throw new Error("cleanup kill failed");
                    };
                  }
                  throw inputFailure;
                },
              }),
            );
          },
          {
            prefix: path.join(path.basename(ownerRoot), "home-"),
            ...(unjoined ? { env: { TMPDIR: ownerRoot, TMP: ownerRoot, TEMP: ownerRoot } } : {}),
          },
        ).catch((error: unknown) => error);
        const runtimeCleanupFailure = await cleanupRuntime().catch((error: unknown) => error);

        expect(hasUnjoinedWork(failure)).toBe(unjoined);
        expect(process.env.HOME).toBe(originalHome);
        expect(process.env.OPENCLAW_STATE_DIR).toBe(originalStateDir);
        if (unjoined) {
          expect(failure).toMatchObject({ cause: inputFailure });
          expect(child?.exitCode).toBeNull();
          expect(child?.signalCode).toBeNull();
          expect(cleanup).not.toHaveBeenCalled();
          expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          if (cleanupMode === "exit-timeout") {
            expect(String(failure)).toContain("did not exit within 5000ms after SIGKILL");
          }
          expect(await fs.readFile(path.join(home!, "owned.txt"), "utf8")).toBe(
            "retain while live",
          );
          expect(await fs.readFile(path.join(home!, ".openclaw", "child.txt"), "utf8")).toBe(
            "child state",
          );
          expect(await fs.readFile(runtimePath, "utf8")).toBe(runtimeSource);
        } else {
          expect(failure).toBe(inputFailure);
          expect(cleanupSignals).toEqual(["SIGKILL"]);
          expect(() => owner.assertReleased()).not.toThrow();
          await expect(fs.stat(home!)).rejects.toMatchObject({ code: "ENOENT" });
          await expect(fs.stat(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(hasUnjoinedWork(runtimeCleanupFailure)).toBe(unjoined);
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
        await cleanupRuntime();
      }
    },
  );

  it("shares a failed acquisition, then recovers on the next explicit call", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "sdk-home-acquisition-"));
    const missingParent = path.join(parent, "missing");
    const prefix = path.join(path.basename(parent), "missing", "shared-");
    const options = { prefix, skipSessionCleanup: true };
    const unexpectedCallback = async () => {
      throw new Error("callback must not run when root acquisition fails");
    };
    try {
      const failures = await Promise.allSettled([
        withTempHomeCore(unexpectedCallback, options),
        withTempHomeCore(unexpectedCallback, options),
        withTempHomeCore(unexpectedCallback, options),
      ]);
      const errors = failures.map((result) => {
        expect(result.status).toBe("rejected");
        return result.status === "rejected" ? result.reason : undefined;
      });
      expect(errors[0]).toMatchObject({ code: "ENOENT" });
      expect(errors.every((error) => error === errors[0])).toBe(true);
      expect(await fs.readdir(parent)).toEqual([]);

      await fs.mkdir(missingParent);
      const first = await withTempHomeCore(
        async (home) => {
          await fs.writeFile(path.join(home, "retained.txt"), "keep");
          return home;
        },
        { ...options, skipHomeCleanup: true },
      );
      const second = await withTempHomeCore(async (home) => home, options);
      const third = await withTempHomeCore(async (home) => home, options);
      expect(path.dirname(second)).toBe(path.dirname(first));
      expect(path.dirname(third)).toBe(path.dirname(first));
      expect([first, second, third].map((home) => path.basename(home))).toEqual([
        "case-0",
        "case-1",
        "case-2",
      ]);
      expect(await fs.readdir(path.dirname(first))).toEqual([path.basename(first)]);
      expect(await fs.readFile(path.join(first, "retained.txt"), "utf8")).toBe("keep");
      const independent = await withTempHomeCore(async (home) => home, {
        prefix: path.join(path.basename(parent), "independent-"),
        skipSessionCleanup: true,
      });
      expect(path.dirname(independent)).not.toBe(path.dirname(first));
      expect(await fs.readdir(path.dirname(independent))).toEqual([]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
