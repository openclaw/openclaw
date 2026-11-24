import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { sendGatewayCronFailureAlert } from "../gateway/server-cron-notifications.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createNoopLogger } from "./service.test-harness.js";

it("records an unrouted failure alert once in the owning conversation", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const sessionKey = "agent:main:dashboard:failure-alert-owner";
    const sessionId = "failure-alert-owner";
    const storePath = state.path("agents", "main", "sessions", "sessions.json");
    const scope = { agentId: "main", sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    const onDeliverySettled = vi.fn(async () => {});
    const request = {
      job: {
        id: "failing-job",
        name: "failing job",
        agentId: "main",
        sessionTarget: "current",
        sessionKey,
        wakeMode: "now",
        state: { lastFailureNotificationId: "failure-incident" },
      },
      routing: { defaultAgentId: "main" },
      payload: { text: "Unrouted cron failure" },
      runAtMs: 1,
      channel: "last",
      mode: "announce",
      onDeliverySettled,
      deps: {} as never,
      logger: createNoopLogger(),
      resolveCronAgent: () => ({ agentId: "main", cfg: { session: { store: storePath } } }),
    } as const;

    await sendGatewayCronFailureAlert(request);
    await sendGatewayCronFailureAlert(request);
    expect(onDeliverySettled).toHaveBeenCalledWith({ delivered: true, status: "delivered" });
    const transcript = () => loadTranscriptEvents({ ...scope, sessionId });
    expect(JSON.stringify(await transcript()).match(/Unrouted cron failure/g)).toHaveLength(1);

    await expect(
      sendGatewayCronFailureAlert({ ...request, to: "explicit-destination" }),
    ).rejects.toThrow();
    expect(onDeliverySettled).toHaveBeenLastCalledWith(
      expect.objectContaining({ delivered: false }),
    );
    expect(JSON.stringify(await transcript()).match(/Unrouted cron failure/g)).toHaveLength(1);
  });
});
