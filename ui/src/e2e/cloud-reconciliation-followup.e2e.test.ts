import path from "node:path";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:cloud-reconciliation";
const now = Date.now();

function placement(
  state: "active" | "failed",
  updatedAt: number,
  workspaceResultReconciling = false,
) {
  const timing = {
    createdAtMs: now - 180_000,
    generation: state === "failed" ? 3 : 2,
    stateChangedAtMs: now - 138_000,
    updatedAtMs: updatedAt,
  };
  if (state === "failed") {
    return {
      ...timing,
      state,
      recoveryAction: "restart" as const,
      recoveryError: "Workspace reconciliation failed: local worktree is locked.",
    };
  }
  return {
    ...timing,
    state,
    activeOwnerEpoch: 4,
    environmentId: "cloud-environment-4242",
    profileId: "standard",
    providerId: "crabbox",
    remoteWorkspaceDir: "/workspace/openclaw",
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "manifest-before-sync",
    ...(workspaceResultReconciling ? { workspaceResultReconciling: true as const } : {}),
  };
}

function session(
  state: "active" | "failed",
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
    placement: placement(state, updatedAt, workspaceResultReconciling),
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
  it("shows safe sync custody, resumes, and reserves red for true failure", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProofEnabled
          ? { recordVideo: { dir: path.join(suite.artifactDir, "cloud-reconciliation") } }
          : {}),
      },
      async ({ page }) => {
        const reconciling = session("active", false, true);
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

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("chat.startup");
        await page.getByRole("button", { name: "Cloud · syncing files" }).waitFor();
        await page.getByText("Safely applying cloud edits", { exact: false }).waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await page.getByText("your message starts automatically", { exact: false }).waitFor();
        await expect
          .poll(() =>
            page.getByText("Received · waiting for workspace sync", { exact: true }).count(),
          )
          .toBe(0);

        await composer.fill(pendingInput.message.content);
        await page.getByRole("button", { name: "Send message" }).click();
        const firstFollowUp = await gateway.waitForRequest("chat.send");
        expect(firstFollowUp.params).toMatchObject({ message: pendingInput.message.content });
        // Echo the browser submission identity so custody replaces its optimistic bubble.
        const runId = requireString(requireRecord(firstFollowUp.params).idempotencyKey, "run id");
        const admittedInput = { ...pendingInput, runId };
        await gateway.resolveDeferred("chat.send", {
          runId,
          status: "started",
        });

        const queued = session("active", true, true, runId);
        const queuedHistory = {
          ...reconcilingHistory,
          pendingInputs: { items: [admittedInput], total: 1 },
          sessionInfo: queued,
        };
        await gateway.setMethodResponse("chat.history", queuedHistory);
        await gateway.setMethodResponse("chat.startup", queuedHistory);
        await gateway.setSessionsListResponse(chatSessionListResponse([queued]));
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          hasActiveRun: true,
          reason: "send",
          sessionKey,
        });
        await page.getByText("Received · waiting for workspace sync", { exact: true }).waitFor();
        await expect
          .poll(() => page.getByText(pendingInput.message.content, { exact: true }).count())
          .toBe(1);
        if (captureUiProofEnabled) {
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, "cloud-reconciliation", "01-slow-sync.png"),
          });
        }

        const active = session("active");
        // The persisted event and later history reads describe the same reply.
        const resumedReplyId = "automatic-follow-up-result";
        const resumedReply = {
          role: "assistant",
          content: "The queued follow-up started automatically.",
          __openclaw: { id: resumedReplyId, seq: 3, runId },
        };
        const activeHistory = {
          inFlightRun: null,
          messages: [
            { role: "assistant", content: "Cloud edits are ready to apply." },
            {
              ...pendingInput.message,
              __openclaw: { id: "persisted-follow-up", idempotencyKey: `${runId}:user` },
            },
            resumedReply,
          ],
          pendingInputs: { items: [], total: 0 },
          sessionId: active.sessionId,
          sessionInfo: active,
          thinkingLevel: null,
        };
        await gateway.setMethodResponse("chat.history", activeHistory);
        await gateway.setMethodResponse("chat.startup", activeHistory);
        await gateway.setSessionsListResponse(chatSessionListResponse([active]));
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          reason: "placement",
          sessionKey,
        });
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [],
          hasActiveRun: false,
          message: resumedReply,
          messageId: resumedReplyId,
          messageSeq: resumedReply["__openclaw"].seq,
          runId,
          session: active,
          sessionKey,
        });
        await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "final" });
        await page
          .getByRole("paragraph")
          .filter({ hasText: "The queued follow-up started automatically." })
          .waitFor();
        await expect
          .poll(() =>
            page.getByText("Received · waiting for workspace sync", { exact: true }).count(),
          )
          .toBe(0);
        await expect
          .poll(() => page.getByText(pendingInput.message.content, { exact: true }).count())
          .toBe(1);
        if (captureUiProofEnabled) {
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, "cloud-reconciliation", "02-resumed.png"),
          });
        }

        const completedUpdatedAt = await page.evaluate(async (key) => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime?: { context: ApplicationContext };
          };
          const sessions = app.runtime?.context.sessions;
          if (!sessions) {
            throw new Error("session capability unavailable");
          }
          await sessions.refresh({ agentId: "main", force: true });
          return sessions.state.result?.sessions.find((row) => row.key === key)?.updatedAt;
        }, sessionKey);
        expect(completedUpdatedAt).toBeGreaterThan(active.updatedAt);

        const failed = session("failed");
        expect(completedUpdatedAt).toBeLessThanOrEqual(failed.updatedAt);
        const failedHistory = { ...activeHistory, sessionInfo: failed };
        await gateway.setMethodResponse("chat.history", failedHistory);
        await gateway.setMethodResponse("chat.startup", failedHistory);
        await gateway.setSessionsListResponse(chatSessionListResponse([failed]));
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "main",
          reason: "placement",
          sessionKey,
        });
        await page.getByText("Runner failed", { exact: true }).waitFor();
        await page
          .getByText("Workspace reconciliation failed: local worktree is locked.", { exact: false })
          .waitFor();
        if (captureUiProofEnabled) {
          await page.screenshot({
            fullPage: true,
            path: path.join(suite.artifactDir, "cloud-reconciliation", "03-true-failure.png"),
          });
        }
      },
    );
  });
});
