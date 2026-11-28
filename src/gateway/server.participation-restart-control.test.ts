import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { getAgentEventLifecycleGeneration, onAgentEventForRun } from "../infra/agent-events.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import * as restartResume from "./session-restart-resume.js";

it("replays ordinary owner-only queued input through the same restart lifecycle", async ({
  signal,
}) => {
  const enqueue = sessionEvents.enqueueSessionEventForHost;
  const resumed = createDeferred<SessionEventReceipt>();
  using eventObserver = vi
    .spyOn(sessionEvents, "enqueueSessionEventForHost")
    .mockImplementation((...args) => {
      const receipt = enqueue(...args);
      if (args[1].source === "restart") {
        resumed.resolve(receipt);
      }
      return receipt;
    });
  void eventObserver;
  let recovered = createDeferred();
  const resume = restartResume.resumeMarkedSessions;
  using observer = vi
    .spyOn(restartResume, "resumeMarkedSessions")
    .mockImplementation(async (...args) => {
      try {
        await resume(...args);
      } finally {
        recovered.resolve();
      }
    });
  void observer;
  await withInvitedGuestGateway(
    signal,
    async (fixture) => {
      await withinTest(recovered.promise, signal);
      const { state, providerReplies, providerRequests } = fixture;
      const owner = await fixture.sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        { agentId: "main", label: "Owner-only queued control", permissionMode: "full" },
        { signal },
      );
      const target = { agentId: "main", sessionKey: owner.key };
      const reached = createDeferred();
      providerReplies.reply = () => reached.resolve();
      await fixture.sender.request(
        "chat.send",
        { ...target, message: "OWNER_RUNNING", idempotencyKey: "owner-restart-running" },
        { signal },
      );
      await withinTest(reached.promise, signal);
      await fixture.sender.request(
        "chat.send",
        {
          ...target,
          message: "OWNER_QUEUED",
          queueMode: "followup",
          idempotencyKey: "owner-restart-queued",
        },
        { signal },
      );
      const queued = (
        await listSessionPendingInputs({ ...target, sessionId: owner.sessionId })
      ).items.find((item) => item.runId === "owner-restart-queued");
      expect(queued?.state).toBe("queued");
      const before = providerRequests.length;
      recovered = createDeferred();
      providerReplies.reply = (_body, response) =>
        writeOpenAiResponsesText(response, {
          text: "OWNER_RESUMED",
          messageId: "owner-resumed",
          responseId: "owner-resumed-response",
        });
      const queuedSettled = createDeferred();
      using queuedEvents = new DisposableStack();
      await fixture.restart(async () => {
        queuedEvents.defer(
          onAgentEventForRun("owner-restart-queued", (event) => {
            if (
              event.lifecycleGeneration === getAgentEventLifecycleGeneration() &&
              event.stream === "lifecycle" &&
              (event.data.phase === "end" || event.data.phase === "error") &&
              event.data.executionSettled === true
            ) {
              queuedSettled.resolve();
            }
          }),
        );
      });
      await withinTest(recovered.promise, signal);
      const rootReceipt = await withinTest(resumed.promise, signal);
      const rootOutcome = await withinTest(rootReceipt.settled, signal);
      console.info("ROOT_RESTART_OUTCOME", JSON.stringify({ id: rootReceipt.id, rootOutcome }));
      expect(rootOutcome).toMatchObject({ status: "completed", executionStarted: true });
      // Queued agent.wait returns pending immediately; wait for execution before its publication.
      await withinTest(queuedSettled.promise, signal);
      const completed = await fixture.sender.request(
        "agent.wait",
        { runId: "owner-restart-queued", timeoutMs: 30_000 },
        { signal },
      );
      expect(completed).toMatchObject({ status: "ok" });
      const pending = await listSessionPendingInputs({ ...target, sessionId: owner.sessionId });
      expect
        .soft(
          pending.items.find((item) => item.id === queued?.id),
          "ordinary retained input consumed",
        )
        .toBeUndefined();
      const history = await fixture.sender.request<{ messages: unknown[] }>(
        "chat.history",
        target,
        { signal },
      );
      expect
        .soft(JSON.stringify(history.messages), "ordinary queued input committed")
        .toContain("OWNER_QUEUED");
      expect(JSON.stringify(history.messages)).toContain("OWNER_RESUMED");
      expect(
        providerRequests
          .slice(before)
          .some((body) => body.includes("The Gateway restarted while you were working.")),
        "root resume reaches model",
      ).toBe(true);
      expect(
        providerRequests
          .slice(before)
          .every((body) =>
            (JSON.parse(body) as { tools: { name: string }[] }).tools.some(
              (tool) => tool.name === "write",
            ),
          ),
      ).toBe(true);
      console.info(
        "ordinary-restart-proof",
        JSON.stringify({
          owner,
          inputId: queued?.id,
          before,
          after: providerRequests.length,
          stateRoot: state.root,
          queued: pending.items.map(({ id, state: inputState }) => ({ id, state: inputState })),
        }),
      );
    },
    { tools: { allow: ["read", "write"], toolSearch: false, codeMode: { enabled: false } } },
  );
});
