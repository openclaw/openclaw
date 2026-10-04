import path from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.state.test-support.js";

const closeDatabase = vi.hoisted(() => vi.fn<(pathname: string) => Promise<boolean>>());
vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabaseByPathAsync: closeDatabase,
}));
vi.mock("../config/paths.js", async () => ({
  resolveStateDir: (await import("../config/state-dir.js")).resolveStateDir,
}));

afterEach(() => {
  closeDatabase.mockReset();
  vi.unstubAllEnvs();
});

describe("worker environment startup fixture lifetime", () => {
  it.each([
    { bodyFailed: false, drainFailed: false },
    { bodyFailed: true, drainFailed: false },
    { bodyFailed: false, drainFailed: true },
    { bodyFailed: true, drainFailed: true },
  ])(
    "retains state and both outcomes through drainage (body failed: $bodyFailed, drain failed: $drainFailed)",
    async ({ bodyFailed, drainFailed }) => {
      const outerState = path.resolve("/synthetic/outer-state");
      const stateDir = path.resolve("/synthetic/startup-state");
      vi.stubEnv("OPENCLAW_STATE_DIR", outerState);
      const entered = createDeferredCore();
      const drained = createDeferredCore<boolean>();
      closeDatabase.mockImplementation((pathname) => {
        expect(pathname).toBe(path.join(stateDir, "state", "openclaw.sqlite"));
        entered.resolve();
        return drained.promise;
      });
      const failure = new Error("synthetic body failure");
      const cleanupFailure = new Error("synthetic drainage failure");
      let settled = false;
      const outcome = withGatewayWorkerEnvironmentStartupState(stateDir, async () => {
        if (bodyFailed) {
          throw failure;
        }
        return "body result";
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      void outcome.then(() => {
        settled = true;
      });
      try {
        await Promise.race([entered.promise, outcome]);
        await yieldToEventLoop();
        expect(settled).toBe(false);
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
      } finally {
        if (drainFailed) {
          drained.reject(cleanupFailure);
        } else {
          drained.resolve(true);
        }
        await outcome;
      }
      if (bodyFailed && drainFailed) {
        await expect(outcome).resolves.toMatchObject({
          error: { name: "AggregateError", errors: [failure, cleanupFailure], cause: failure },
        });
      } else {
        await expect(outcome).resolves.toEqual(
          bodyFailed
            ? { error: failure }
            : drainFailed
              ? { error: cleanupFailure }
              : { value: "body result" },
        );
      }
      expect(process.env.OPENCLAW_STATE_DIR).toBe(outerState);
    },
  );
});
