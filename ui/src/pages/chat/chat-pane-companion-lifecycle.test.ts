/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-companion-lifecycle.test/"} */

import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createGatewayRequestMock } from "../../test-helpers/gateway-client.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import {
  createGatewayBrowserClientFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatSessionCompanionThreads } from "./chat-session-companion.ts";

const companionThreads = (pane: TestChatPane) =>
  (pane as TestChatPane & { sessionCompanionThreads: ChatSessionCompanionThreads })
    .sessionCompanionThreads;
const current = "agent:main:current";
const other = "agent:main:other";
const question = "current question";

it("preserves threads while a same-client reconnect settles a pending answer", async () => {
  const consoleError = vi.spyOn(console, "error");
  onTestFinished(() => consoleError.mockRestore());
  const models: ModelCatalogEntry[] = [
    { id: "fixture-model", name: "Fixture model", provider: "test", available: true },
  ];
  const historyReady = createDeferred();
  onTestFinished(() => historyReady.resolve());
  const replies: Record<string, unknown> = {
    "agents.list": makeBootRoster(),
    "sessions.subscribe": { subscribed: true, list: sessionsResult([], 1) },
    "sessions.messages.subscribe": { subscribed: true, key: current },
    "sessions.messages.unsubscribe": { subscribed: false, key: current },
    "models.authStatus": { ts: 1, providers: [] },
    "models.list": { commands: [], models, swarmEnabled: false },
    "chat.metadata": { commands: [], models, swarmEnabled: false },
  };
  const request = createGatewayRequestMock(async (method) => {
    if (method === "chat.startup") {
      await historyReady.promise;
      return { messages: [], sessionId: "session-current", hasMore: false, totalMessages: 0 };
    }
    if (Object.hasOwn(replies, method)) {
      return replies[method];
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  const client = createGatewayBrowserClientFixture({ request });
  const { pane, state } = createTestChatPane({ client });
  state.loadAssistantIdentity = vi.fn(async () => undefined);
  const answer = createDeferred<{ answer: string; ts: number }>();
  const threads = companionThreads(pane);
  const view = (key = current) => threads.view(key, "main");
  const hydrate = (...exchanges: Array<{ question: string; answer: string; ts: number }>) =>
    threads.hydrate(current, async () => ({ exchanges }), "main");
  const earlier = { question: "Earlier question", answer: "Earlier answer", ts: 1 };
  await hydrate(earlier);
  const pending = threads.submit(current, question, () => answer.promise, "main");
  threads.setDraft(other, "other draft", "main");

  // GatewayProtocolClient flushes pending requests before publishing the
  // reconnecting snapshot; Promise rejection settles on the next microtask.
  answer.reject(new Error("gateway closed"));
  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    phase: "reconnecting",
    hello: null,
  });

  expect(view().turns).toMatchObject([
    { ...earlier, status: "answered" },
    { question, status: "pending" },
  ]);
  expect(view(other).draft).toBe("other draft");
  await pending;
  expect(view().turns).toMatchObject([
    { ...earlier, status: "answered" },
    { question, status: "failed", hint: "unavailable", retryable: true },
  ]);

  pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot, phase: "connected" });
  expect(state.chatModelsLoading).toBe(true);
  expect(view(other).draft).toBe("other draft");
  await hydrate(earlier, { question, answer: "Recovered answer", ts: 2 });
  expect(view().turns).toMatchObject([
    { ...earlier, status: "answered" },
    { question, status: "answered", answer: "Recovered answer", ts: 2 },
  ]);
  await vi.waitFor(() => expect(state.chatModelsLoading).toBe(false));
  expect(consoleError).not.toHaveBeenCalled();
  expect(state.chatModelCatalog).toEqual(models);
  expect(state.chatModelCatalogError).toBeNull();
  const history = getChatHistoryLoadState(state);
  expect(history.phase).toBe("in-flight");
  historyReady.resolve();
  if (history.phase === "in-flight") {
    await history.promise;
  }
  expect(getChatHistoryLoadState(state).phase).toBe("committed");
  expect(state.chatError).toBeNull();
});

it("retires every thread and late answer when the Gateway client is replaced", async () => {
  const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const replacement = { request: vi.fn() } as unknown as GatewayBrowserClient;
  const { pane } = createTestChatPane({ client });
  const threads = companionThreads(pane);
  const answer = createDeferred<{ answer: string; ts: number }>();
  const pending = threads.submit(current, "replace this question", () => answer.promise, "main");
  threads.setDraft(other, "replace this draft", "main");

  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    client: replacement,
    phase: "reconnecting",
    hello: null,
  });

  expect(threads.view(current, "main").turns).toMatchObject([]);
  expect(threads.view(other, "main").draft).toBe("");
  answer.resolve({ answer: "late answer", ts: 3 });
  await pending;
  expect(threads.view(current, "main").turns).toMatchObject([]);
});
