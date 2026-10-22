import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { admitModelTurn, completionConfig } from "../agents/bash-tools.lifecycle.test-support.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createCronServiceState } from "../cron/service/state.js";
import { wake as wakeCronService } from "../cron/service/wake.js";
import { createGatewayCronTargetResolver } from "../gateway/server-cron-targets.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

// mock-isolation: Replace model inference while retaining Cron admission and session settlement.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

it("runs a targeted manual next-heartbeat wake without a recurring schedule", async ({
  signal,
  onTestFinished,
}) => {
  const fixtureWork = withOpenClawTestState(
    { label: "manual-wake-without-cadence", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      const cfg = completionConfig(state.workspaceDir);
      setRuntimeConfigSnapshot(cfg);
      await state.writeConfig(cfg);
      openOpenClawStateDatabase();
      const scope = { agentId: "main", sessionKey: "agent:main:main" };
      await replaceSessionEntry(scope, {
        sessionId: "manual-wake-session",
        lifecycleRevision: "original",
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        permissionMode: "full",
      });
      const text = "Operator requested a session update.";
      model.mockReset().mockImplementation(async (params) => {
        await admitModelTurn(params);
        expect(params.trigger).toBe("event");
        expect(params.sessionKey).toBe(scope.sessionKey);
        expect(params.prompt).toContain(text);
        return { payloads: [{ text: "Manual wake completed" }], meta: { durationMs: 1 } };
      });
      const receipts: sessionEvents.SessionEventReceipt[] = [];
      const enqueue = sessionEvents.enqueueSessionEventForHost;
      const observe = vi
        .spyOn(sessionEvents, "enqueueSessionEventForHost")
        .mockImplementation((message, options) => {
          const receipt = enqueue(message, options);
          receipts.push(receipt);
          return receipt;
        });
      const scheduler = createTestGatewayScheduler();
      const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const enqueueSystemEvent = vi.fn();
      const cron = createCronServiceState({
        scheduler,
        storePath: state.path("cron.json"),
        cronEnabled: true,
        log,
        enqueueSystemEvent,
        runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok" }),
        enqueueSessionEvent: createGatewayCronTargetResolver(state.env, log).enqueueSessionEvent,
      });
      try {
        await expect(
          wakeCronService(cron, { mode: "next-heartbeat", text, ...scope }),
        ).resolves.toEqual({ ok: true });
        expect(receipts).toHaveLength(1);
        const receipt = expectDefined(receipts[0], "ordinary manual wake receipt");
        await expect(withinTest(receipt.settled, signal)).resolves.toMatchObject({
          status: "completed",
          executionStarted: true,
          summary: "Manual wake completed",
        });
        expect(model).toHaveBeenCalledOnce();
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(peekSystemEvents(scope.sessionKey)).toEqual([]);
      } finally {
        for (const receipt of receipts) {
          receipt.cancel();
        }
        await Promise.allSettled(receipts.map((receipt) => receipt.settled));
        await scheduler.stop();
        observe.mockRestore();
        resetSystemEventsForTest();
      }
    },
  );
  onTestFinished(async () => {
    await Promise.allSettled([fixtureWork]);
  });
  await fixtureWork;
});
