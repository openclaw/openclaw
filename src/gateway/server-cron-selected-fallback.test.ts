import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../test/helpers/cron/service-regression-fixtures.js";
import { withinTest } from "../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import * as routedReplies from "../auto-reply/reply/route-reply.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import {
  configureEventState,
  runEventFixture,
  startEmbeddedTurn,
} from "../auto-reply/reply/session-event.test-support.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { cronNotificationJob } from "../cron/service/notification-intents.js";
import { enqueueCronNotification } from "../cron/service/wake.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveGatewayCronOriginDeliveryContext } from "./server-cron-event-dispatch.js";
import { createGatewayCronTargetResolver } from "./server-cron-targets.js";

// mock-isolation: Only model output and external channel I/O are synthetic; retain the real
// cron fallback, Gateway target resolution, session-event admission, and reply dispatcher.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

it.for([
  { kind: "auto-disabled", selected: true },
  { kind: "failure-alert", selected: true },
  { kind: "auto-disabled", selected: false },
] as const)(
  "keeps $kind fallback internal only when a conversation was selected ($selected)",
  async ({ kind, selected }, { signal, onTestFinished }) => {
    await runEventFixture("cron-selected-fallback", onTestFinished, async (state) => {
      await configureEventState(state);
      const sessionKey = "agent:main:main";
      const marker = "Selected notification fallback observed";
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "notice-owner-main",
          lifecycleRevision: "notice-owner-generation",
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "synthetic-remembered-chat" },
          }),
        },
      );
      vi.mocked(runEmbeddedAgent)
        .mockReset()
        .mockImplementation(async (params) => {
          await startEmbeddedTurn(params, "cron fallback admission");
          return { payloads: [{ text: marker }], meta: { durationMs: 1 } };
        });
      const external = vi.spyOn(routedReplies, "routePreparedReply").mockResolvedValue({
        ok: true,
        delivered: true,
      });
      const enqueue = sessionEvents.enqueueSessionEventForHost;
      const receipts: ReturnType<typeof enqueue>[] = [];
      const observed = vi
        .spyOn(sessionEvents, "enqueueSessionEventForHost")
        .mockImplementation((text, options) => {
          const receipt = enqueue(text, options);
          receipts.push(receipt);
          return receipt;
        });
      try {
        const target = createGatewayCronTargetResolver(state.env, { warn: vi.fn() });
        const service = createCronRegressionState({
          storePath: state.statePath("cron", "jobs.json"),
          defaultAgentId: "main",
          runIsolatedAgentJob: vi.fn(),
          enqueueSessionEvent: target.enqueueSessionEvent,
          resolveOriginDeliveryContext: (opts) =>
            resolveGatewayCronOriginDeliveryContext(opts, target.resolveCronTarget),
        });
        const job = cronNotificationJob(
          makeCronJob({
            agentId: "main",
            sessionKey,
            delivery: selected
              ? { mode: "none", sessionKey: "agent:main:dashboard:missing-inbox" }
              : { mode: "none" },
          }),
        );
        await enqueueCronNotification(service, job, "Automation needs attention", kind, {});
        expect(receipts).toHaveLength(1);
        const receipt = receipts[0]!;
        await expect(receipt.accepted).resolves.toEqual({ ok: true });
        expect(await withinTest(receipt.settled, signal)).toMatchObject({
          status: "completed",
          executionStarted: true,
          delivered: !selected,
          deliveryAttempted: !selected,
          summary: marker,
        });
        expect(external).toHaveBeenCalledTimes(selected ? 0 : 1);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(vi.mocked(runEmbeddedAgent)).toHaveBeenCalledOnce();
      } finally {
        for (const receipt of receipts) {
          receipt.cancel();
        }
        await Promise.allSettled(receipts.map((receipt) => receipt.settled));
        observed.mockRestore();
        external.mockRestore();
      }
    });
  },
);
