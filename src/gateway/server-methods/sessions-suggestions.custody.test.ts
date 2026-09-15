import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  listSessionPendingInputs,
  loadTranscriptEventsSync,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { addSessionSuggestion } from "../../config/sessions/session-suggestion-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { handleGatewayRequest } from "../server-methods.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { sessionSuggestionHandlers } from "./sessions-suggestions.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createBrowserFollowupFixture = useBrowserFollowupFixture();

describe("suggestion dispatch through real chat input custody", () => {
  it.each([
    "profile before custody",
    "request before custody",
    "profile after custody",
    "host after custody",
  ] as const)("preserves the authority boundary for %s", async (change) => {
    const fixture = await createBrowserFollowupFixture({
      preserveContent: true,
      persistDuringDispatch: true,
    });
    const email = "suggestion-custody@example.test";
    const profile = ensureProfileForEmail(email);
    const mergedProfile = ensureProfileForEmail("suggestion-custody-merged@example.test");
    fixture.client.authenticatedUserProfile = {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    };
    const suggestionId = "custody-suggestion";
    const runId = `session-suggestion:${suggestionId}`;
    const text = "Review this synthetic suggestion after the current task.";
    addSessionSuggestion(fixture.scope, { id: suggestionId, authorId: profile.id, text });
    const { db } = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(fixture.scope)));
    const claim = () =>
      db
        .prepare("SELECT state, dispatch_token FROM session_suggestions WHERE id = ?")
        .get(suggestionId);
    const requestAbort = new AbortController();
    let hostCurrent = true;
    const resolveSuggestion = async (expectedProfileId = profile.id) => {
      const respond = vi.fn<RespondFn>();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "suggestion-custody-request",
          method: "session.suggestions.resolve",
          expectedProfileId,
          params: { sessionKey: fixture.scope.sessionKey, id: suggestionId, resolution: "queue" },
        },
        client: fixture.client,
        context: fixture.context,
        respond,
        isWebchatConnect: () => true,
        signal: requestAbort.signal,
        sessionMutationCommitGuard: () => {
          if (!hostCurrent) {
            throw new Error("The original suggestion host has closed.");
          }
        },
        extraHandlers: sessionSuggestionHandlers,
      });
      return respond;
    };
    const beforeCustody =
      change === "profile before custody" || change === "request before custody";
    if (beforeCustody) {
      fixture.beforeApprove.mockImplementation(() => {
        expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        if (change === "profile before custody") {
          linkEmail(email, mergedProfile.id);
        } else {
          requestAbort.abort();
        }
      });
    }
    try {
      const response = await resolveSuggestion();
      expect(fixture.beforeApprove).toHaveBeenCalledOnce();
      expect(response).toHaveBeenCalledOnce();
      if (beforeCustody) {
        expect.soft(response.mock.calls[0]?.[0]).toBe(false);
        expect.soft(claim()).toEqual({ state: "pending", dispatch_token: null });
        expect.soft(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        expect.soft(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
        expect.soft(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect.soft(fixture.context.chatAbortControllers.has(runId)).toBe(false);
        expect.soft(fixture.context.chatQueuedTurns.size).toBe(0);
        return;
      }

      expect(response.mock.calls[0]).toMatchObject([
        true,
        { suggestion: { id: suggestionId, state: "accepted" } },
      ]);
      expect(claim()).toEqual({ state: "accepted", dispatch_token: null });
      const pending = listSessionPendingInputs(fixture.scope);
      expect(pending).toMatchObject({
        total: 1,
        items: [{ state: "queued", message: { content: text } }],
      });
      expect(loadTranscriptEventsSync(fixture.scope)).toEqual(fixture.activeTranscript);
      const recorder = await fixture.dispatchedRecorder;
      const acceptedResponse = structuredClone(response.mock.calls);
      linkEmail(email, mergedProfile.id);
      if (change === "host after custody") {
        hostCurrent = false;
      }
      await fixture.finishDispatch();
      expect(response.mock.calls).toEqual(acceptedResponse);
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(claim()).toEqual({ state: "accepted", dispatch_token: null });
      if (change === "profile after custody") {
        const transcript = loadTranscriptEventsSync(fixture.scope);
        expect(transcript).toHaveLength(fixture.activeTranscript.length + 1);
        expect(transcript.at(-1)).toMatchObject({ message: { role: "user", content: text } });
        expect(recorder.getAdmissionReceipt()).toBeDefined();
        expect(listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        const retry = await resolveSuggestion(mergedProfile.id);
        expect(retry.mock.calls[0]).toMatchObject([
          false,
          undefined,
          { message: "pending suggestion not found" },
        ]);
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual(transcript);
      } else {
        expect(recorder.getAdmissionReceipt()).toBeUndefined();
        const transcript = loadTranscriptEventsSync(fixture.scope);
        expect(transcript.filter((entry) => isRecord(entry) && entry.type === "message")).toEqual(
          fixture.activeTranscript.filter((entry) => isRecord(entry) && entry.type === "message"),
        );
        expect(transcript).toContainEqual(
          expect.objectContaining({
            type: "custom_message",
            customType: "run-failed-before-reply",
            details: expect.objectContaining({ runId }),
          }),
        );
        expect(listSessionPendingInputs(fixture.scope)).toMatchObject({
          total: 1,
          items: [{ id: pending.items[0]?.id, state: "interrupted", message: { content: text } }],
        });
        expect(fixture.context.dedupe.get(`chat:${runId}`)).toMatchObject({
          ok: false,
          payload: { runId, status: "error" },
          error: {
            message: expect.stringContaining("Message injection authority is no longer current"),
          },
        });
      }
      expect(fixture.context.chatAbortControllers.size).toBe(0);
      expect(fixture.context.chatQueuedTurns.size).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
});
