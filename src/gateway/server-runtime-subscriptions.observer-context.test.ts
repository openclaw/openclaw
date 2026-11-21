import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { heartbeatNotifications } from "../infra/heartbeat-events.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSubscriptionTestFixture,
  waitForFast,
} from "./server-runtime-subscriptions.test-support.js";

const runtimeConfigState = vi.hoisted(() => ({
  value: { logging: { audit: { enabled: false } } } as OpenClawConfig,
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => runtimeConfigState.value,
}));

// mock-isolation: the lazily loaded chat handler consumes the same events but is not under test.
vi.mock("./server-chat.js", () => ({
  createAgentEventHandler: () => Object.assign(vi.fn(), { dispose: vi.fn() }),
}));

const { startGatewayEventSubscriptions } = await import("./server-runtime-subscriptions.js");

afterEach(() => {
  heartbeatNotifications.onEvent = () => {};
  resetAgentEventsForTest();
});

it("publishes the observer preamble for events emitted inside a writer admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:writer-held";
    const runId = "writer-held-run";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey },
      { sessionId: "writer-held", updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const { warn, createParams } = createSubscriptionTestFixture();
    const params = createParams();
    params.sessionMessageSubscribers.subscribe("conn-observer", sessionKey)?.commit();
    const unsubs = startGatewayEventSubscriptions(params);
    try {
      unsubs.sessionObserver.setConnectionVisibility("conn-observer", true);
      // A worker reservation publishes run progress while it still holds the agent
      // database writer. The observer's ordered read must queue behind that writer
      // instead of inheriting the producer's context and reentering it.
      await runOpenClawAgentWorkerWrite({ agentId: "main" }, async () => {
        emitAgentEvent({
          runId,
          sessionKey,
          agentId: "main",
          stream: "item",
          data: { kind: "preamble", phase: "update", progressText: "Reading the held session" },
        });
        // Release the writer only once the observer read has queued behind it or failed.
        await waitForFast(
          () =>
            expect(
              (SQLITE_SESSION_WRITER_QUEUES.get(database.path)?.pending.length ?? 0) > 0 ||
                warn.mock.calls.length > 0,
            ).toBe(true),
          { timeout: 10_000 },
        );
      });
      await unsubs.agentUnsub();

      expect(warn).not.toHaveBeenCalled();
      expect(params.broadcastToConnIds).toHaveBeenCalledWith(
        "session.observer",
        expect.objectContaining({ sessionKey, runId, headline: "Reading the held session" }),
        new Set(["conn-observer"]),
        expect.objectContaining({ agentId: "main" }),
      );
    } finally {
      await unsubs.agentUnsub();
      unsubs.transcriptUnsub();
      unsubs.lifecycleUnsub();
    }
  });
});
