/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadChatHistory } from "./chat-history.ts";
import {
  input,
  makeChatPageHost,
  sessionId,
  sessionKey,
} from "./chat-pending-inputs.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";

it.each([
  "consumed",
  "queued",
  "retired-before-decline",
  "unknown-method",
  "disconnected",
] as const)("steers original server custody without a replacement send: %s", async (outcome) => {
  const ack = createDeferred<{ status: "accepted" | "queued"; reason?: string }>();
  const requested = createDeferred();
  const queued = { ...input, state: "queued" as const, queued: true };
  let retired = false;
  const host = makeChatPageHost({
    sessionKey,
    currentSessionId: sessionId,
    chatMessage: "Unfinished draft",
    requestHandlers: {
      "chat.history": () => ({
        sessionId,
        sessionInfo: { key: sessionKey, sessionId },
        messages: [],
        pendingInputs: {
          items: retired ? [] : [queued],
          total: retired ? 0 : 1,
          queuedCount: retired ? 0 : 1,
        },
        inputReceipts: [
          { runId: queued.runId!, state: retired ? "consumed" : "pending", queued: !retired },
        ],
      }),
      "chat.steer": () => {
        requested.resolve();
        return ack.promise;
      },
    },
  });
  await loadChatHistory(host);
  const view = getChatPendingInputs(host)!;
  const action = host.steerQueuedChatMessage("pending-input:" + queued.id);
  await requested.promise;
  expect(host.request).toHaveBeenCalledWith("chat.steer", {
    sessionKey,
    agentId: "main",
    sessionId,
    runId: queued.runId,
  });
  await host.steerQueuedChatMessage("pending-input:" + queued.id);
  expect(host.request.mock.calls.filter(([method]) => method === "chat.steer")).toHaveLength(1);
  expect(view.queuedInputs).toHaveLength(1);
  if (outcome === "disconnected") {
    host.connectionEpoch += 1;
    applyChatPendingInputs(host, { items: [], total: 0, queuedCount: 0 });
  }
  retired = outcome === "consumed" || outcome === "retired-before-decline";
  if (outcome === "unknown-method") {
    ack.reject(new Error("Unknown method: chat.steer"));
  } else {
    ack.resolve({
      status: outcome === "queued" || outcome === "retired-before-decline" ? "queued" : "accepted",
      reason: "Cannot steer now; input remains queued.",
    });
  }
  await action;
  expect(host.chatMessage).toBe("Unfinished draft");
  expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(view.steering?.size).toBe(0);
  if (outcome === "unknown-method") {
    expect(view.queuedInputs).toHaveLength(1);
    expect(view.error).toContain("Unknown method");
  } else if (outcome === "queued") {
    expect(view.queuedInputs).toHaveLength(1);
    expect(view.error).toContain("remains queued");
  } else {
    expect(getChatPendingInputs(host)?.queuedInputs ?? []).toHaveLength(0);
    expect(view.error).toBeUndefined();
  }
});
