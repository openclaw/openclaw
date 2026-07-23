import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function waitForPath(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runLeaseChild(scriptPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lease child exited ${code}: ${output}`));
      }
    });
  });
}

describe("plugin lifecycle lease", () => {
  it("serializes lifecycle work sharing one state directory", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-lease" }, async (state) => {
      const firstEntered = deferred();
      const releaseFirst = deferred();
      const events: string[] = [];

      const first = withPluginLifecycleLease(
        { env: state.env, leaseMs: 1_000, waitMs: 3_000 },
        async () => {
          events.push("first-enter");
          firstEntered.resolve();
          await releaseFirst.promise;
          events.push("first-exit");
        },
      );
      await firstEntered.promise;

      const second = withPluginLifecycleLease(
        { env: state.env, leaseMs: 1_000, waitMs: 3_000 },
        async () => {
          events.push("second-enter");
        },
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(events).toEqual(["first-enter"]);

      releaseFirst.resolve();
      await Promise.all([first, second]);
      expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
    });
  });

  it("serializes lifecycle work across processes", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-processes" }, async (state) => {
      const firstMarker = state.path("first-entered");
      const releaseMarker = state.path("release-first");
      const secondMarker = state.path("second-entered");
      const secondReady = state.path("second-ready");
      const secondResult = state.path("second-result");
      const leaseModuleUrl = pathToFileURL(
        path.resolve("src/plugins/plugin-lifecycle-lease.ts"),
      ).href;
      const childScript = await state.writeText(
        "lease-child.mts",
        `
          import fs from "node:fs/promises";
          import { withPluginLifecycleLease } from ${JSON.stringify(leaseModuleUrl)};
          const [role, stateDir, firstMarker, releaseMarker, secondMarker, secondReady, secondResult] = process.argv.slice(2);
          const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
          if (role === "second") {
            await fs.writeFile(secondReady, "ready");
            try {
              await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 0 }, async () => {
                await fs.writeFile(secondMarker, "entered");
              });
              await fs.writeFile(secondResult, "acquired");
            } catch (error) {
              await fs.writeFile(secondResult, error?.code ?? String(error));
            }
          } else {
            await withPluginLifecycleLease({ env, leaseMs: 1_000, waitMs: 5_000 }, async () => {
              await fs.writeFile(firstMarker, "entered");
              while (true) {
                try {
                  await fs.access(releaseMarker);
                  break;
                } catch {
                  await new Promise((resolve) => {
                    setTimeout(resolve, 25);
                  });
                }
              }
            });
          }
        `,
      );

      const childArgs = [
        state.stateDir,
        firstMarker,
        releaseMarker,
        secondMarker,
        secondReady,
        secondResult,
      ];
      const first = runLeaseChild(childScript, ["first", ...childArgs]);
      await waitForPath(firstMarker);
      const second = runLeaseChild(childScript, ["second", ...childArgs]);
      await waitForPath(secondReady);
      await waitForPath(secondResult);

      let assertionError: unknown;
      try {
        await expect(fs.readFile(secondResult, "utf8")).resolves.toBe(
          "OPENCLAW_STATE_LEASE_TIMEOUT",
        );
        await expect(fs.access(secondMarker)).rejects.toMatchObject({ code: "ENOENT" });
      } catch (error) {
        assertionError = error;
      } finally {
        await fs.writeFile(releaseMarker, "release");
      }
      await Promise.all([first, second]);
      if (assertionError) {
        throw assertionError instanceof Error
          ? assertionError
          : new Error("cross-process lease assertion failed", { cause: assertionError });
      }
    });
  });

  it("reuses the active lease for nested lifecycle work", async () => {
    await withOpenClawTestState({ label: "plugin-lifecycle-reentrant" }, async (state) => {
      const events: string[] = [];
      await withPluginLifecycleLease({ env: state.env, leaseMs: 1_000, waitMs: 0 }, async () => {
        events.push("outer");
        await withPluginLifecycleLease({ env: state.env, leaseMs: 1_000, waitMs: 0 }, async () => {
          events.push("inner");
        });
      });
      expect(events).toEqual(["outer", "inner"]);
    });
  });
});
