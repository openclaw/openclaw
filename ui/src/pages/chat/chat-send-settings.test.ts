/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult, SessionsPatchResult } from "../../api/types.ts";
import { sessionsResult as sessionListFixture } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createResolvedModelPatch,
  createSessionsListResult,
} from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  expectRpc,
  findRequestPayload,
  makeChatHost,
  requestCalls,
  requireRecord,
} from "./chat-host.test-support.ts";
import { row } from "./chat-outbox-recovery.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { switchChatModel, switchChatSetting } from "./chat-session.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
const defaults = { defaultAgentId: "main", mainKey: "main", mainSessionKey: "agent:main:main" };
const hello = { ...sessionMutationGatewayHello(), snapshot: { sessionDefaults: defaults } };
const model = "gpt-5.6-luna";
function modelHost(
  overrides: Parameters<typeof makeChatHost>[0] & { requestHandlers: Record<string, unknown> },
) {
  const host = makeChatHost({ sessionKey: "main", hello, ...overrides });
  onTestFinished(() => host.sessions.dispose());
  return host;
}

it("does not patch the model for a locked session", async () => {
  const sessionsResult = createSessionsListResult({ model: "gpt-5.5" });
  Object.assign(sessionsResult.sessions[0]!, {
    key: "agent:main:main",
    modelSelectionLocked: true,
  });
  const host = modelHost({ requestHandlers: {}, sessionsResult });

  await expect(switchChatModel(host, "openai/gpt-5.4")).resolves.toBe(false);
  expect(host.request).not.toHaveBeenCalled();
});

it("sends without waiting for the background roster", async () => {
  const message = "send without changing a picker";
  const roster = createDeferred<SessionsListResult>();
  const host = modelHost({
    sessionKey: "agent:main",
    hello: sessionMutationGatewayHello(),
    requestHandlers: {
      "sessions.list": () => roster.promise,
      "chat.send": { status: "started" },
    },
    chatMessage: message,
  });
  const refresh = host.sessions.refresh({ force: true });
  try {
    expect(getPendingChatPickerPatch(host, host.sessionKey)).toBeUndefined();
    await handleSendChat(host);
    expect(host.request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
    expectRpc(host.request, "chat.send", expect.objectContaining({ message }));
  } finally {
    roster.resolve(createSessionsListResult());
    await refresh;
  }
});

it.each(["success", "failure"] as const)(
  "settles picker %s before later refresh",
  async (outcome) => {
    const patch = createDeferred<SessionsPatchResult>();
    const reconciliation = createDeferred<SessionsListResult>();
    const unrelated = createDeferred<SessionsListResult>();
    const initial = createSessionsListResult({ model: "gpt-5", modelOverrideSource: "user" });
    initial.sessions[0]!.sessionId = "main";
    const result = createSessionsListResult({ model, modelOverrideSource: "user" });
    const rosters = [initial, reconciliation.promise, unrelated.promise];
    const list = vi.fn(() => rosters.shift() ?? unrelated.promise);
    const host = modelHost({
      requestHandlers: {
        "sessions.patch": () => patch.promise,
        "sessions.list": list,
        "chat.send": { status: "started" },
      },
      chatMessage: "use my confirmed model",
    });
    await host.sessions.refresh({ agentId: "main", force: true });
    const selection = switchChatModel(host, `openai/${model}`);
    const send = handleSendChat(host);
    let later: Promise<void> | undefined;
    try {
      await waitForFast(() => expect(host.chatQueue[0]?.sendState).toBe("waiting-model"));
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      patch.resolve(createResolvedModelPatch(model, "openai"));
      await waitForFast(() => expect(list).toHaveBeenCalledTimes(2));
      later = host.sessions.refresh({ force: true, backgroundHydrate: true });
      if (outcome === "failure") {
        reconciliation.reject(new Error("Roster refresh unavailable"));
      } else {
        reconciliation.resolve(result);
      }
      await waitForFast(() => expect(list).toHaveBeenCalledTimes(3));
      await waitForFast(() =>
        expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(true),
      );
      await expect(selection).resolves.toBe(true);
      await send;
      expect(host.sessions.state.modelOverrides.main).toBeUndefined();
      expect(host.sessions.state.result?.sessions[0]?.model).toBe(model);
      if (outcome === "failure") {
        expect(host.sessions.state.error).toBe("Roster refresh unavailable");
      }
    } finally {
      patch.resolve(createResolvedModelPatch(model, "openai"));
      reconciliation.resolve(result);
      unrelated.resolve(result);
      await Promise.allSettled([selection, send, later]);
    }
  },
);

it("waits for every pending reasoning and speed patch before sending chat", async () => {
  const thinkingUpdate = createDeferred<unknown>();
  const thinkingRequested = createDeferred();
  const fastModeUpdate = createDeferred<unknown>();
  installOutboxBrowserStorage();
  const sessionsResult = sessionListFixture([
    row("agent:main", {
      effectiveFastMode: false,
      fastMode: false,
      thinkingLevel: "low",
    }),
  ]);
  const host = makeChatHost({
    requestHandlers: {
      "sessions.patch": (params: unknown) => {
        const patch = requireRecord(params, "session settings patch");
        if (Object.hasOwn(patch, "thinkingLevel")) {
          thinkingRequested.resolve();
          return thinkingUpdate.promise;
        }
        if (Object.hasOwn(patch, "fastMode")) {
          return fastModeUpdate.promise;
        }
        throw new Error("Unexpected sessions.patch payload");
      },
      "sessions.list": () => Promise.resolve(sessionsResult),
      "chat.send": () => Promise.resolve({ status: "started" }),
    },
    chatMessage: "use the new reasoning and speed",
    sessionsResult,
  });
  const thinkingPatch = switchChatSetting(host, { kind: "thinkingLevel", value: "high" });
  const fastModePatch = switchChatSetting(host, { kind: "fastMode", value: "on" });
  const send = handleSendChat(host);
  await thinkingRequested.promise;

  expect(requestCalls(host.request, "sessions.patch")).toHaveLength(1);
  expect(requestCalls(host.request, "chat.send")).toStrictEqual([]);
  expect(host.chatQueue[0]).toMatchObject({
    sendState: "waiting-model",
    text: "use the new reasoning and speed",
  });

  thinkingUpdate.resolve({});
  await thinkingPatch;
  await waitForFast(() => expect(requestCalls(host.request, "sessions.patch")).toHaveLength(2));
  expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);

  fastModeUpdate.resolve({});
  await Promise.all([fastModePatch, send]);
  const payload = findRequestPayload(host.request, "chat.send", "chat send payload");
  expect(payload).toMatchObject({
    message: "use the new reasoning and speed",
    sessionKey: "agent:main",
  });
});
