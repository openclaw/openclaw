/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createApplicationGatewaySnapshot } from "../../test-helpers/application-context-fixtures.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { readChatPaneRouteMutationAccess } from "./chat-pane-session-controls.ts";
import { useChatSendBrowserFixture } from "./outbox-browser.test-support.ts";

useChatSendBrowserFixture();

const mainKey = "agent:main:main";
const row = (sharingRole: GatewaySessionRow["sharingRole"]): GatewaySessionRow => ({
  key: mainKey,
  kind: "direct",
  sessionId: "created-by-someone",
  sharingRole,
});

it("gates the first turn on proven absence only until the session has a row", async () => {
  let history: { messages: never[]; sessionId?: string } = { messages: [] };
  const host = makeChatHost({
    sessionKey: mainKey,
    hello: sessionMutationGatewayHello(["operator.sessions.write"]),
    requestHandlers: { "chat.history": () => history },
  });
  const snapshot = createApplicationGatewaySnapshot({
    client: host.client,
    phase: "connected",
    hello: host.hello,
  });
  const canSend = (session?: GatewaySessionRow) =>
    readChatPaneRouteMutationAccess(snapshot, host, session).composeScope.allowed;

  // Roster absence alone proves nothing.
  expect(canSend()).toBe(false);
  await loadChatHistory(host);
  expect(canSend()).toBe(true);
  // A row that arrives later takes over, whatever the earlier read proved.
  expect(canSend(row("viewer"))).toBe(false);
  expect(canSend(row("member"))).toBe(false);
  expect(canSend(row("owner"))).toBe(true);

  // A later read that finds the session replaces the proof.
  history = { messages: [], sessionId: "created-by-someone" };
  await loadChatHistory(host);
  expect(canSend()).toBe(false);
  history = { messages: [] };
  await loadChatHistory(host);
  expect(canSend()).toBe(true);
  // The proof belongs to the connection that read it.
  host.connectionEpoch += 1;
  expect(canSend()).toBe(false);
});

it("keeps one agent's empty history from opening another agent's global conversation", async () => {
  let refuse = false;
  const host = makeChatHost({
    sessionKey: "global",
    assistantAgentId: "main",
    hello: sessionMutationGatewayHello(["operator.sessions.write"]),
    requestHandlers: {
      "chat.history": () => {
        if (refuse) {
          throw new Error("history unavailable");
        }
        return { messages: [] };
      },
    },
  });
  const snapshot = createApplicationGatewaySnapshot({
    client: host.client,
    phase: "connected",
    hello: host.hello,
  });
  const canSend = () => readChatPaneRouteMutationAccess(snapshot, host).composeScope.allowed;

  await loadChatHistory(host);
  expect(canSend()).toBe(true);
  // Same connection and key, another agent: its read fails, so nothing proves absence.
  refuse = true;
  host.assistantAgentId = "research";
  await loadChatHistory(host).catch(() => undefined);
  expect(canSend()).toBe(false);
});
