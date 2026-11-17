import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createHookRunner } from "./hooks.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRecord } from "./status.test-helpers.js";

const event = { runId: "failed-run", summary: "Your request couldn't be completed." };
const context = { agentId: "main", sessionKey: "agent:main:main", sessionId: "session" };

describe("run_failed hooks", () => {
  it.each([
    { allowed: false, sessionKey: context.sessionKey, delivered: false },
    { allowed: true, sessionKey: context.sessionKey, delivered: true },
    { allowed: true, sessionKey: "agent:main:dashboard:incognito-private", delivered: false },
  ])(
    "requires conversation access and excludes incognito: %j",
    async ({ allowed, sessionKey, delivered }) => {
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({ id: "failure-observer", origin: "global" });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, {
        config: {},
        hookPolicy: { allowConversationAccess: allowed },
      });
      const instance = getPluginInstance(record)!;
      onTestFinished(async () => {
        await instance.dispose();
      });
      const handler = vi.fn();
      api.on("run_failed", handler);
      await createHookRunner(builder.registry).runRunFailed(event, { ...context, sessionKey });
      expect(handler).toHaveBeenCalledTimes(delivered ? 1 : 0);
      if (delivered) {
        expect(handler).toHaveBeenCalledWith(event, context);
      }
    },
  );

  it("bounds a stalled observer and logs failure without failing the caller", async () => {
    vi.useFakeTimers();
    const release = createDeferredCore();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const { runner } = createHookRunnerWithRegistry(
      [{ hookName: "run_failed", handler: () => release.promise }],
      { logger, catchErrors: true },
    );
    try {
      const running = runner.runRunFailed(event, context);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(running).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("run_failed"));
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
  });
});
