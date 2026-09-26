import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  cleanupStartedFixture,
  createChatTerminalObserver,
  createFreshSession,
  registerIdempotentCleanup,
  settleFixtureWork,
  startLocalModeFixture,
} from "./tui-pty-local-test-support.js";
import type { PtyRun } from "./tui-pty-test-support.js";

const SUBMISSION_SETTLE_MS = 150;
const SESSION_ROLLOVER_BUSY_MESSAGE = "abort the current run before /new";

describe("local TUI PTY fixture support", () => {
  it("registers idempotent cleanup before fallible fixture setup", async () => {
    const order: string[] = [];
    let registeredCleanup: (() => Promise<void>) | undefined;
    const setupError = new Error("setup failed");
    let cleanupCalls = 0;

    await expect(
      (async () => {
        const cleanup = registerIdempotentCleanup(
          (registered) => {
            order.push("registered");
            registeredCleanup = registered;
          },
          async () => {
            cleanupCalls += 1;
            order.push("cleanup");
          },
        );
        try {
          order.push("setup");
          throw setupError;
        } finally {
          await cleanup();
        }
      })(),
    ).rejects.toBe(setupError);
    await registeredCleanup!();

    expect(order).toEqual(["registered", "setup", "cleanup"]);
    expect(cleanupCalls).toBe(1);
  });

  it("does not publish a fixture whose registered cleanup started during setup", async () => {
    await withTempDir("tui-local-publication-test-", async (root) => {
      const owner = createVitestResourceOwner(root);
      const entered = createDeferred();
      const releaseSetup = createDeferred();
      const disposing = createDeferred();
      const releaseDisposal = createDeferred();
      let registeredCleanup: (() => Promise<void>) | undefined;
      let cleanup: Promise<void> | undefined;
      let inputRoot = "";
      let disposals = 0;
      let consumed = false;
      const startup = startLocalModeFixture(
        (registered) => {
          registeredCleanup = registered;
        },
        async (lifetime, tempDir) => {
          inputRoot = tempDir;
          entered.resolve();
          await releaseSetup.promise;
          await lifetime.acquire(async () => ({
            cleanup: async () => {
              disposals += 1;
              disposing.resolve();
              await releaseDisposal.promise;
            },
          }));
          return { value: "late fixture" };
        },
        root,
      );
      const outcome = startup.then(
        () => {
          consumed = true;
          return "published";
        },
        (error: unknown) => error,
      );
      try {
        await expect(
          Promise.race([entered.promise.then(() => "entered"), outcome.then(() => "completed")]),
        ).resolves.toBe("entered");
        if (!registeredCleanup) {
          throw new Error("local fixture cleanup was not registered");
        }
        cleanup = registeredCleanup();
        releaseSetup.resolve();
        await expect(
          Promise.race([
            disposing.promise.then(() => "disposing"),
            outcome.then(() => "completed"),
          ]),
        ).resolves.toBe("disposing");
        expect(fs.existsSync(inputRoot)).toBe(true);
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        releaseDisposal.resolve();
        const error = await outcome;
        expect(error).toBeInstanceOf(Error);
        expect(error).toHaveProperty(
          "message",
          "local TUI PTY fixture setup completed after cleanup started",
        );
        expect(consumed).toBe(false);
        expect(disposals).toBe(1);
        expect(fs.existsSync(inputRoot)).toBe(false);
        expect(() => owner.assertReleased()).not.toThrow();
        await cleanup;
      } finally {
        cleanup ??= registeredCleanup?.();
        releaseSetup.resolve();
        releaseDisposal.resolve();
        await Promise.allSettled([startup, cleanup]);
      }
    });
  });

  it.each([false, true])(
    "joins held cleanup work before releasing inputs (rejected=%s)",
    async (rejected) => {
      await withTempDir("tui-local-lifetime-test-", async (root) => {
        // These explicit owners contain synthetic work only; the outer test
        // removes deliberately retained inputs after every probe has joined.
        const owner = createVitestResourceOwner(root);
        const entered = createDeferred();
        const release = createDeferred();
        const failure = new Error("first cleanup failed");
        const order: string[] = [];
        let inputRoot = "";
        const remove = fs.promises.rm.bind(fs.promises);
        const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
          if (target === inputRoot) {
            order.push("remove");
            expect(order).toEqual(["sibling entered", "sibling settled", "remove"]);
          }
          await remove(target, options);
        });
        let cleanup: Promise<unknown> | undefined;
        try {
          const fixture = await startLocalModeFixture(
            () => {},
            async (lifetime, tempDir) => {
              inputRoot = tempDir;
              fs.writeFileSync(path.join(tempDir, "input"), "still owned");
              await lifetime.acquire(async () => ({
                cleanup: () =>
                  settleFixtureWork([
                    rejected ? Promise.reject(failure) : Promise.resolve(),
                    (async () => {
                      order.push("sibling entered");
                      entered.resolve();
                      await release.promise;
                      expect(fs.readFileSync(path.join(tempDir, "input"), "utf8")).toBe(
                        "still owned",
                      );
                      if (rejected) {
                        throw undefined;
                      }
                    })().finally(() => {
                      order.push("sibling settled");
                    }),
                  ]),
              }));
              return {};
            },
            root,
          );
          cleanup = fixture.cleanup().catch((error: unknown) => error);
          try {
            await expect(
              Promise.race([
                entered.promise.then(() => "entered"),
                cleanup.then(() => "completed"),
              ]),
            ).resolves.toBe("entered");
            expect(fs.existsSync(inputRoot)).toBe(true);
            expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          } finally {
            release.resolve();
            await cleanup;
          }
          const error = await cleanup;
          if (rejected) {
            if (
              !(error instanceof AggregateError) ||
              !(error.errors[0] instanceof AggregateError)
            ) {
              throw new Error("fixture cleanup did not retain both failures");
            }
            expect(error.errors[0].errors).toEqual([failure, undefined]);
            expect(error.errors[0].errors[0]).toBe(failure);
            expect(order).toEqual(["sibling entered", "sibling settled"]);
            expect(fs.existsSync(inputRoot)).toBe(true);
            expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          } else {
            expect(error).toBeUndefined();
            expect(order).toEqual(["sibling entered", "sibling settled", "remove"]);
            expect(fs.existsSync(inputRoot)).toBe(false);
            expect(() => owner.assertReleased()).not.toThrow();
          }
        } finally {
          release.resolve();
          await cleanup;
          removal.mockRestore();
        }
      });
    },
  );

  it.each(["prelaunch", "opaque acquisition", "failed cleanup"] as const)(
    "preserves %s failure and releases only verified inputs",
    async (fault) => {
      await withTempDir("tui-local-acquisition-test-", async (root) => {
        const owner = createVitestResourceOwner(root);
        const failure = new Error("local setup failed");
        const order: string[] = [];
        let inputRoot = "";
        const error = await startLocalModeFixture(
          () => order.push("registered"),
          async (lifetime, tempDir) => {
            order.push("setup");
            inputRoot = tempDir;
            await lifetime.acquire(async () => ({
              cleanup: async () => {
                order.push("cleanup");
                if (fault === "failed cleanup") {
                  throw undefined;
                }
              },
            }));
            if (fault === "opaque acquisition") {
              await lifetime.acquire(async () => {
                throw failure;
              });
            }
            throw failure;
          },
          root,
        ).catch((cause: unknown) => cause);
        expect(order).toEqual(["registered", "setup", "cleanup"]);
        if (fault === "prelaunch") {
          expect(error).toBe(failure);
          expect(fs.existsSync(inputRoot)).toBe(false);
          expect(() => owner.assertReleased()).not.toThrow();
        } else {
          if (!(error instanceof AggregateError)) {
            throw new Error("local fixture did not retain startup and cleanup failures");
          }
          expect(error.errors[0]).toBe(failure);
          expect(error.errors[1]).toMatchObject({
            errors: [fault === "opaque acquisition" ? failure : undefined],
          });
          expect(fs.existsSync(inputRoot)).toBe(true);
          expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        }
      });
    },
  );

  it("waits for the matching successful terminal event before history observation", async () => {
    const observer = createChatTerminalObserver();
    const terminal = observer.waitForFinal({
      runId: "run-history",
      sessionKey: "agent:main:history",
      timeoutMs: 1_000,
    });

    observer.onEvent({
      event: "chat",
      payload: {
        runId: "run-history",
        sessionKey: "agent:main:history",
        state: "delta",
      },
    });
    observer.onEvent({
      event: "chat",
      payload: {
        runId: "run-other",
        sessionKey: "agent:main:history",
        state: "final",
      },
    });
    observer.onEvent({
      event: "chat",
      payload: {
        runId: "run-history",
        sessionKey: "agent:main:history",
        state: "final",
      },
    });

    await expect(terminal).resolves.toMatchObject({ state: "final" });
  });

  it("fails promptly when the observed chat run terminates with an error", async () => {
    const observer = createChatTerminalObserver();
    observer.onEvent({
      event: "chat",
      payload: {
        errorMessage: "provider failed",
        runId: "run-history",
        sessionKey: "agent:main:history",
        state: "error",
      },
    });

    await expect(
      observer.waitForFinal({
        runId: "run-history",
        sessionKey: "agent:main:history",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("chat run run-history ended as error: provider failed");
  });

  it("owns late fixture startup without swallowing cleanup failures", async () => {
    await expect(cleanupStartedFixture(Promise.reject(new Error("setup failed")))).resolves.toBe(
      undefined,
    );

    const cleanupError = new Error("cleanup failed");
    const fixture = {
      cleanup: async () => {
        throw cleanupError;
      },
    };
    await expect(cleanupStartedFixture(Promise.resolve(fixture))).rejects.toBe(cleanupError);
  });

  it("does not replay a session rollover when an old busy notice is redrawn", async () => {
    const newSessionPrefix = "new session: agent:main:tui-";
    const acceptedSession = createDeferred();
    const writes: string[] = [];
    let output = "";
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined;
    const run = {
      cols: 100,
      output: () => output,
      pid: 123,
      rows: 30,
      visibleOutput: () => output.replace(/\s+/gu, " "),
      write: async (data: string) => {
        writes.push(data);
        if (writes.length === 1) {
          output += `${SESSION_ROLLOVER_BUSY_MESSAGE}\n`;
          acceptanceTimer = setTimeout(() => {
            output += `${newSessionPrefix}accepted\nlocal ready | idle\n`;
            acceptedSession.resolve();
          }, SUBMISSION_SETTLE_MS + 50);
          return;
        }
        output += `${newSessionPrefix}duplicate\nlocal ready | idle\n`;
      },
      waitForOutput: async () => output,
      waitForExit: async () => ({ exitCode: 0, signal: 0 }),
      forceKill: async () => {},
      dispose: async () => {},
    } satisfies PtyRun;

    try {
      await createFreshSession(run, newSessionPrefix);
      await acceptedSession.promise;
      expect(writes).toEqual(["/new\r"]);
    } finally {
      if (acceptanceTimer) {
        clearTimeout(acceptanceTimer);
      }
    }
  });
});
