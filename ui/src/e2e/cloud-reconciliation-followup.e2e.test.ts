import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { sessionMessage } from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:cloud-reconciliation";
const now = Date.now();

function session(
  queuedFollowUp = false,
  workspaceResultReconciling = false,
  runId = "follow-up-run",
) {
  // The mock run owner advances updatedAt on ACK/final; later states must stay current.
  const updatedAt = Date.now();
  return {
    activeRunIds: queuedFollowUp ? [runId] : [],
    hasActiveRun: queuedFollowUp,
    key: sessionKey,
    kind: "direct",
    label: "Cloud reconciliation proof",
    placement: {
      createdAtMs: now - 180_000,
      generation: 2,
      stateChangedAtMs: now - 138_000,
      updatedAtMs: updatedAt,
      state: "active",
      activeOwnerEpoch: 4,
      environmentId: "cloud-environment-4242",
      profileId: "standard",
      providerId: "crabbox",
      remoteWorkspaceDir: "/workspace/openclaw",
      workerBundleHash: "a".repeat(64),
      workspaceBaseManifestRef: "manifest-before-sync",
      ...(workspaceResultReconciling ? { workspaceResultReconciling: true as const } : {}),
    },
    sessionId: "cloud-reconciliation-session",
    status: queuedFollowUp ? "running" : "done",
    updatedAt,
  };
}

const pendingInput = {
  acceptedAt: now - 120_000,
  id: "pending-follow-up",
  message: {
    __openclaw: { id: "pending:pending-follow-up" },
    content: "Please continue with the exact follow-up.",
    role: "user",
    timestamp: now - 120_000,
  },
  runId: "follow-up-run",
  state: "queued",
};

suite.define(() => {
  it("keeps one follow-up through workspace sync custody and automatic resumption", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const waiting = page.getByText("Received · waiting for workspace sync", { exact: true });
      const followUp = page.getByText(pendingInput.message.content, { exact: true });
      const reconciling = session(false, true);
      const reconcilingHistory = {
        inFlightRun: null,
        messages: [{ role: "assistant", content: "Cloud edits are ready to apply." }],
        pendingInputs: { items: [], total: 0 },
        sessionId: reconciling.sessionId,
        sessionInfo: reconciling,
        thinkingLevel: null,
      };
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-4o",
        models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
        methodResponses: {
          "chat.history": reconcilingHistory,
          "chat.startup": reconcilingHistory,
          "sessions.list": chatSessionListResponse([reconciling]),
        },
        deferredMethods: ["chat.send"],
        sessionInfo: reconciling,
        sessionKey,
        sessions: [reconciling],
      });
      const setHistory = async (
        history: { sessionInfo: ReturnType<typeof session> },
        reason: "send" | "placement",
      ) => {
        await gateway.setMethodResponse("chat.history", history);
        await gateway.setMethodResponse("chat.startup", history);
        await gateway.setSessionsListResponse(chatSessionListResponse([history.sessionInfo]));
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          sessionKey,
          reason,
          ...(reason === "send" ? { hasActiveRun: true } : {}),
        });
      };

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await page.getByText("your message starts automatically", { exact: false }).waitFor();
      await expect.poll(() => waiting.count()).toBe(0);

      await composer.fill(pendingInput.message.content);
      await page.getByRole("button", { name: "Send message" }).click();
      const firstFollowUp = await gateway.waitForRequest("chat.send");
      expect(firstFollowUp.params).toMatchObject({ message: pendingInput.message.content });
      // Echo the browser submission identity so custody replaces its optimistic bubble.
      const runId = requireString(requireRecord(firstFollowUp.params).idempotencyKey, "run id");
      await gateway.resolveDeferred("chat.send", {
        runId,
        status: "started",
      });

      const pendingHistory = {
        ...reconcilingHistory,
        pendingInputs: { items: [{ ...pendingInput, runId }], total: 1 },
        sessionInfo: session(true, true, runId),
      };
      await setHistory(pendingHistory, "send");
      await waiting.waitFor();
      await expect.poll(() => followUp.count()).toBe(1);

      const active = session();
      const resumedReplyId = "automatic-follow-up-result";
      const resumedReply = {
        role: "assistant",
        content: "The queued follow-up started automatically.",
        __openclaw: { id: resumedReplyId, seq: 3, runId },
      };
      const activeHistory = {
        ...reconcilingHistory,
        messages: [
          ...reconcilingHistory.messages,
          {
            ...pendingInput.message,
            __openclaw: { id: "persisted-follow-up", idempotencyKey: `${runId}:user` },
          },
          resumedReply,
        ],
        sessionInfo: active,
      };
      await setHistory(activeHistory, "placement");
      await gateway.emitGatewayEvent(
        "session.message",
        sessionMessage(resumedReply, resumedReplyId, resumedReply["__openclaw"].seq, active, {
          runId,
        }),
      );
      await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "final" });
      await page
        .getByRole("paragraph")
        .filter({ hasText: "The queued follow-up started automatically." })
        .waitFor();
      await expect.poll(() => waiting.count()).toBe(0);
      await expect.poll(() => followUp.count()).toBe(1);

      const completedUpdatedAt = await evaluateControlUiContext(
        page,
        async (context, key) => {
          const sessions = context.sessions;
          await sessions.refresh({ agentId: "main", force: true });
          return sessions.state.result?.sessions.find((row) => row.key === key)?.updatedAt;
        },
        sessionKey,
      );
      expect(completedUpdatedAt).toBeGreaterThan(active.updatedAt);
    });
  });
});
