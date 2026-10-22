/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../api/types.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../../lib/sessions/session-capability.test-support.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { refreshPageChat } from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { createMessageGroupHarness } from "./components/chat-message-native.test-support.tsx";
import { createMessageGroup } from "./components/chat-message.test-support.ts";
import { renderPaneHeaderInto } from "./components/chat-pane-header.test-support.ts";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

async function setup() {
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  const client = store.current();
  Object.assign(client, { recoveryScope: "offline-owner", recoveryScopeReady: true });
  let row: GatewaySessionRow = {
    key: "agent:main:current",
    sessionId: "current-incarnation",
    kind: "direct",
    label: "Original title",
    sharingRole: "owner",
    visibility: "shared",
    updatedAt: 1,
  };
  client.request.mockImplementation(async (method, params) => {
    switch (method) {
      case "users.self":
        return { profile: { id: "alex", displayName: "Alex", emails: [], updatedAt: 1 } };
      case "agents.list":
        return { defaultId: "main", mainKey: "main", agents: [{ id: "main" }] };
      case "sessions.list":
        return sessionsResult([{ ...row }]);
      case "sessions.describe":
        return { session: { ...row } };
      case "sessions.subscribe":
        return { subscribed: true };
      case "sessions.patch":
        row = { ...row, ...asOptionalRecord(params), updatedAt: 2 };
        return { ok: true, key: row.key, path: "", entry: { ...row } };
      case "session.reactions.list":
        return { sessionId: row.sessionId, reactions: {} };
      case "session.members.listEvidence":
        return {
          sessionKey: row.key,
          members: [],
          identities: [],
          role: "owner",
          allowedVisibilities: ["shared", "draft"],
        } satisfies SessionMembersListEvidenceResult;
      case "session.reactions.set":
        return {
          messageId: "message-1",
          reactions: [{ emoji: "👍", count: 1, identities: [{ id: "alex", label: "Alex" }] }],
        };
      case "chat.startup":
        return { messages: [], sessionId: row.sessionId, sessionInfo: { ...row } };
      default:
        return {};
    }
  });
  const hello = {
    ...gatewayHelloForMethods([
      ...SESSION_MUTATION_TEST_METHODS,
      "session.reactions.list",
      "session.reactions.set",
      "users.self",
    ]),
    auth: { role: "operator", scopes: ["operator.admin"], recoveryScope: "offline-owner" },
  };
  client.testOptions.onHello?.(hello);
  await store.gateway.loadSelfProfile();
  const sessions = createTestSessionCapability(store.gateway);
  assert(store.gateway.snapshot.client);
  const { pane, state } = createTestChatPane({ client: store.gateway.snapshot.client, sessions });
  pane.context = {
    ...pane.context,
    gateway: store.gateway,
    runtimeConfig: createRuntimeConfigCapability(store.gateway),
  };
  state.loadAssistantIdentity = vi.fn(async () => undefined);
  const stopSessions = sessions.subscribe((next) => pane.applySessionsState(next));
  const stopGateway = store.gateway.subscribe((next) => pane.applyGatewaySnapshot(next));
  pane.applyGatewaySnapshot(store.gateway.snapshot);
  await sessions.refresh({ agentId: "main" });
  const header = document.createElement("div");
  const messages = document.createElement("div");
  document.body.append(header, messages);
  const message = createMessageGroup(
    {
      role: "assistant",
      content: [{ type: "text", text: "Synthetic reply" }],
      timestamp: 1,
      __openclaw: { id: "message-1" },
    },
    "assistant",
  );
  const transcript = createMessageGroupHarness(messages);
  const draw = () => {
    const layout = pane.render().layout;
    assert(layout?.header);
    renderPaneHeaderInto(layout.header.header, header);
    transcript.render(message, {
      showReasoning: false,
      userId: "alex",
      messageReactions: layout.primary.chat.messageReactions,
      onReact: layout.primary.chat.onReact,
    });
    flush();
  };
  onTestFinished(() => {
    stopSessions();
    stopGateway();
    transcript.unmount();
    pane.context.runtimeConfig.dispose();
    sessions.dispose();
    store.gateway.stop();
    header.remove();
    messages.remove();
  });
  const writes = () => client.request.mock.calls.filter(([method]) => method === "sessions.patch");
  return {
    ...store,
    pane,
    state,
    sessions,
    header,
    messages,
    draw,
    writes,
    disconnect: () =>
      client.testOptions.onClose?.({ code: 1006, reason: "network lost", willRetry: true }),
    reconnect: () => client.testOptions.onHello?.(hello),
  };
}

it.each(["identity change", "retirement", "stop"] as const)(
  "keeps rename and reaction controls through reconnect, but not %s",
  async (retirement) => {
    const h = await setup();
    h.draw();
    expect.soft(h.header.querySelector('button[title="Rename session"]')).not.toBeNull();
    expect.soft(h.messages.querySelectorAll(".chat-reaction-action")).toHaveLength(1);
    h.disconnect();
    expect(h.gateway.snapshot.phase).toBe("reconnecting");
    expect(h.gateway.snapshot.hello).not.toBeNull();
    expect(h.sessions.state.result).toBeNull();
    h.draw();
    expect.soft(h.header.querySelector('button[title="Rename session"]')).not.toBeNull();
    expect.soft(h.messages.querySelectorAll(".chat-reaction-action")).toHaveLength(1);
    if (retirement === "identity change") {
      h.gateway.connect({ token: "synthetic-other-identity" });
    } else if (retirement === "retirement") {
      Object.defineProperty(h.current(), "offlineRecoveryRetired", { value: true });
      h.disconnect();
    } else {
      h.gateway.stop();
    }
    h.draw();
    expect(h.header.querySelector('button[title="Rename session"]')).toBeNull();
    expect(h.messages.querySelectorAll(".chat-reaction-action")).toHaveLength(0);
  },
);

it.each(["descriptor", "startup"] as const)(
  "keeps rename and reactions through a provisional %s publication until the canonical list arrives",
  async (publication) => {
    const h = await setup();
    const retained = h.sessions.presentation.result;
    assert(retained);
    const retainedRow = retained.sessions[0];
    assert(retainedRow);
    const canonical = sessionsResult([
      { ...retainedRow, label: "Reconnected title", archived: true },
    ]);
    const provisional: GatewaySessionRow = {
      key: retainedRow.key,
      sessionId: retainedRow.sessionId,
      kind: "direct",
      label: "Provisional title",
    };
    const pendingList = createDeferred<typeof canonical>();
    onTestFinished(() => pendingList.resolve(canonical));
    const request = h.current().request.getMockImplementation();
    assert(request);
    const reconnectList = vi.fn(() => pendingList.promise);
    h.current().request.mockImplementation((method, params) => {
      if (method === "sessions.list") {
        return reconnectList();
      }
      if (method === "chat.startup") {
        return Promise.resolve({
          messages: [],
          sessionId: provisional.sessionId,
          sessionInfo: provisional,
        });
      }
      return request(method, params);
    });
    h.disconnect();
    h.reconnect();
    await waitForSolid(() => expect(reconnectList).toHaveBeenCalled());
    expect(h.gateway.snapshot.phase).toBe("connected");
    expect(h.sessions.state.result).toBeNull();
    const revision = h.sessions.canonicalListRevision;
    if (publication === "startup") {
      await refreshPageChat(h.state, {
        historyLoad: loadChatHistory(h.state, { startup: true }),
        awaitHistory: true,
        scheduleScroll: false,
      });
    } else {
      expect(h.sessions.reconcile(provisional, undefined, { resultAgentId: "main" })).toBe(true);
    }
    expect(h.sessions.state.result?.sessions[0]?.label).toBe("Provisional title");
    expect(h.sessions.canonicalListRevision).toBe(revision);
    expect(h.sessions.presentation.result).toBe(retained);
    h.draw();
    expect(h.header.textContent).toContain("Original title");
    expect(h.header.querySelector('button[title="Rename session"]')).not.toBeNull();
    expect(h.messages.querySelectorAll(".chat-reaction-action")).toHaveLength(1);

    pendingList.resolve(canonical);
    await waitForSolid(() =>
      expect(selectedChatSessionRow(h.state)?.label).toBe("Reconnected title"),
    );
    h.draw();
    expect(h.header.textContent).toContain("Reconnected title");
    expect(selectedChatSessionRow(h.state)?.archived).toBe(true);
    expect(h.header.querySelector('button[title="Rename session"]')).not.toBeNull();
    expect(h.messages.querySelectorAll(".chat-reaction-action")).toHaveLength(0);
  },
);

it("queues a header rename and rendered reaction through the shared outbox", async () => {
  const h = await setup();
  h.disconnect();
  h.draw();
  const rename = h.header.querySelector<HTMLButtonElement>('button[title="Rename session"]');
  assert(rename);
  rename.click();
  h.draw();
  const input = h.header.querySelector<HTMLInputElement>(".chat-pane__session-title-input");
  assert(input);
  input.value = "Renamed offline";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await waitForSolid(() => expect(h.gateway.snapshot.deferredIntentCount).toBe(1));
  h.draw();
  expect(selectedChatSessionRow(h.state)?.label).toBe("Renamed offline");
  expect(h.header.textContent).toContain("Renamed offline");
  expect(h.writes()).toHaveLength(0);

  const trigger = h.messages.querySelector<HTMLButtonElement>(".chat-reaction-action .trigger");
  assert(trigger);
  trigger.click();
  flush();
  const emoji = [...h.messages.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === "👍",
  );
  assert(emoji);
  emoji.click();
  await waitForSolid(() => expect(h.gateway.snapshot.deferredIntentCount).toBe(2));
  h.draw();
  expect(h.messages.querySelector(".chat-reaction-chip")?.getAttribute("aria-label")).toBe("👍 1");
  const reactions = () =>
    h.current().request.mock.calls.filter(([method]) => method === "session.reactions.set");
  expect(reactions()).toHaveLength(0);

  h.reconnect();
  await waitForSolid(() => expect(h.gateway.snapshot.deferredIntentCount).toBe(0));
  await waitForSolid(() => expect(h.writes()).toHaveLength(1));
  expect(h.writes()[0]?.[1]).toMatchObject({
    key: "agent:main:current",
    expectedSessionId: "current-incarnation",
    label: "Renamed offline",
  });
  await waitForSolid(() => expect(reactions()).toHaveLength(1));
  expect(reactions()[0]?.[1]).toEqual({
    sessionKey: "agent:main:current",
    messageId: "message-1",
    emoji: "👍",
    remove: false,
  });
  await waitForSolid(() => expect(selectedChatSessionRow(h.state)?.label).toBe("Renamed offline"));
});
