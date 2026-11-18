import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import {
  claimProviderReviewAttempt,
  recordSessionProviderReview,
  retireProviderReviewAcknowledgment,
} from "../../sessions/provider-review.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { dispatchGatewayRequestInProcessRaw } from "../server-in-process-dispatch.js";
import type { handleProviderReviewContinuationChat } from "./chat-send-handler.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import { identifiedClient } from "./sessions-read-cache.test-support.js";

const runtime = vi.hoisted(() => ({
  handoff: vi.fn<typeof handleProviderReviewContinuationChat>(),
}));
// mock-isolation: External model acceptance is fixed; router authorization, acknowledgment and SQLite commit are real.
vi.mock("./chat-send-handler.js", () => ({
  handleProviderReviewContinuationChat: runtime.handoff,
}));

afterEach(() => vi.restoreAllMocks());

it.each(["allowed", "read-only", "foreign-owner", "non-ui", "revoked-at-commit"] as const)(
  "native provider-review continuation preserves final-effect authority: %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      runtime.handoff.mockReset();
      const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const owner = ensureProfileForEmail("review-owner@example.test");
      const outsider = ensureProfileForEmail("review-outsider@example.test");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:native-provider-review",
        sessionId: "review-session",
        lifecycleRevision: "review-generation",
      };
      replaceSessionEntrySync(target, {
        sessionId: target.sessionId,
        lifecycleRevision: target.lifecycleRevision,
        updatedAt: 1,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      const review = await recordSessionProviderReview({
        target: { ...target, storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }) },
        refusal: {
          runId: "original-refused-run",
          provider: "openai",
          model: "test-model",
          runtimeId: "codex",
          api: "openai-chatgpt-responses",
          nativeThreadId: "original-thread",
          nativeTurnId: "original-refused-turn",
          review: {
            explanation: "Inspect the synthetic operation.",
            continuation: { message: "/literal continuation" },
          },
        },
        assertCurrent: () => {},
      });
      const before = loadSessionEntry(target);
      const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
      const client = identifiedClient(scenario === "foreign-owner" ? outsider.id : owner.id);
      client.connId = "native-provider-review";
      client.connect.scopes = scenario === "read-only" ? ["operator.read"] : ["operator.write"];
      client.connect.client = {
        id: "openclaw-macos",
        mode: scenario === "non-ui" ? "cli" : "ui",
        platform: "macOS",
        version: "test",
      };
      client.internal = { authenticatedOperator: true };
      const caller = captureGatewayDeviceRevocation(
        context,
        { deviceId: "review-device", role: "operator" },
        () => true,
      );
      let commitReached = false;
      runtime.handoff.mockImplementation(async (options, acknowledgment) => {
        const normalized = await normalizeChatSendRequest({
          params: options.params,
          client: options.client,
          providerReviewAcknowledgment: acknowledgment,
        });
        expect(normalized).toMatchObject({
          ok: true,
          value: { inboundMessage: "/literal continuation", suppressCommandInterpretation: true },
        });
        claimProviderReviewAttempt(acknowledgment, "continued-run");
        await acknowledgment.assertRuntime({
          provider: "openai",
          model: "test-model",
          runtimeId: "codex",
          api: "openai-chatgpt-responses",
          assertCurrent: () => {},
        });
        const probe = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
          if (request.stage === "commit") {
            commitReached = true;
            if (scenario === "revoked-at-commit") {
              invalidateGatewayDeviceRevocation(context, "review-device", "operator");
            }
          }
          return admit(request, grant);
        });
        try {
          await acknowledgment.acceptNativeTurn({
            nativeThreadId: "original-thread",
            nativeTurnId: "new-accepted-turn",
            assertCurrent: () => {},
          });
          options.respond(true, { status: "completed" });
        } finally {
          probe.mockRestore();
          retireProviderReviewAcknowledgment(acknowledgment);
        }
      });
      try {
        const response = await dispatchGatewayRequestInProcessRaw(
          "sessions.providerReview.continue",
          {
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            reviewId: review.id,
            idempotencyKey: "continued-run",
          },
          { client, context, hasCurrentClientAuthority: caller.isCurrent },
        );
        const after = loadSessionEntry(target);
        if (scenario === "allowed") {
          expect(response.ok).toBe(true);
          expect(commitReached).toBe(true);
          expect(after?.providerReview).toBeUndefined();
          expect(after).toMatchObject({
            sessionId: target.sessionId,
            lifecycleRevision: target.lifecycleRevision,
            createdActor: before?.createdActor,
          });
        } else {
          expect(response.ok).toBe(false);
          expect(after).toEqual(before);
          if (scenario === "revoked-at-commit") {
            expect(commitReached).toBe(true);
            expect(caller.isCurrent()).toBe(false);
          } else {
            expect(runtime.handoff).not.toHaveBeenCalled();
          }
        }
      } finally {
        caller.release();
      }
    });
  },
);
