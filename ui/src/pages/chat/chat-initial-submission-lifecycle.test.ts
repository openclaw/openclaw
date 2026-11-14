/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { clearChatHistory } from "./chat-history-actions.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatPageHost } from "./chat-pending-inputs.test-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import { admitChatSubmission } from "./history-merge.ts";
import { applyChatCacheSnapshot } from "./session-message-cache.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

function initialSubmissionFixture() {
  const sessionKey = "agent:main:initial-lifecycle";
  let sessionId = "physical-a";
  const host = makeChatPageHost({
    sessionKey,
    requestHandlers: {
      "chat.history": () => ({
        sessionId,
        messages: [],
        sessionInfo: { key: sessionKey, sessionId, hasActiveRun: true, status: "running" },
      }),
    },
  });
  const owner = expectDefined(host.client, "connected client");
  const submit = (text: string, createdAt: number, runId: string) => {
    const input = expectDefined(
      buildInitialChatSubmission(host.sessionKey, { text, createdAt }, owner, runId),
      "initial prompt",
    );
    host.chatSubmissions.retain(input);
    admitChatSubmission(host, undefined);
    return input;
  };
  const input = submit("original initial prompt", 1, "initial-run");
  const readmit = () => {
    host.chatSubmissions.retain(input);
    admitChatSubmission(host, undefined);
  };
  const retained = expectDefined(
    host.chatSubmissions.readInitial(sessionKey, input.owner),
    "retained initial input",
  );
  const submitNewer = () => submit("new initial prompt", 2, "new-run").message;
  return { host, input, retained, readmit, submitNewer, replace: () => (sessionId = "physical-b") };
}

it.each([
  "physical replacement",
  "completed",
  "uncertain",
  "not-started",
  "rejected",
  "newer handoff",
  "reset",
  "new",
] as const)("preserves initial submission ownership across %s", async (action) => {
  const { host, input, retained, readmit, submitNewer, replace } = initialSubmissionFixture();
  if (action === "physical replacement") {
    applyChatCacheSnapshot(host, {
      messages: [],
      sessionId: "cached-placeholder",
      pagination: { hasMore: false },
    });
    resetChatHistoryProjection(host);
    admitChatSubmission(host, undefined);
    expect(host.chatMessages).toEqual([input.message]);
  }
  await loadChatHistory(host);
  if (action === "physical replacement") {
    expect(host).toMatchObject({ currentSessionId: "physical-a", chatMessages: [input.message] });
    replace();
    await loadChatHistory(host);
    expect(host).toMatchObject({ currentSessionId: "physical-b", chatMessages: [] });
  } else if (action === "reset" || action === "new") {
    handlePageGatewayEvent(host, {
      type: "event",
      event: "sessions.changed",
      payload: {
        sessionKey: host.sessionKey,
        sessionId: host.currentSessionId,
        agentId: "main",
        reason: action,
      },
    });
    await loadChatHistory(host);
  } else {
    const response = createDeferred<"completed" | "uncertain" | "not-started">();
    vi.spyOn(host.sessions, "reset").mockImplementation(() =>
      action === "rejected" ? Promise.reject(new Error("Reset was refused")) : response.promise,
    );
    const clearing = clearChatHistory(host);
    const newer = action === "newer handoff" ? submitNewer() : undefined;
    if (action !== "rejected") {
      response.resolve(action === "newer handoff" ? "completed" : action);
    }
    await clearing;
    if (newer) {
      expect(host.chatMessages).toEqual([newer]);
      expect(retained).toMatchObject({ pending: false, message: null });
      return;
    }
    resetChatHistoryProjection(host);
  }
  const preserved = action === "not-started" || action === "rejected";
  if (!preserved) {
    expect(retained).toMatchObject({ pending: false, message: null });
  }
  readmit();
  expect(host.chatMessages).toEqual(preserved ? [input.message] : []);
  if (action === "reset" || action === "new") {
    const newerMessage = submitNewer();
    expect(host.chatMessages).toEqual([newerMessage]);
  }
});
