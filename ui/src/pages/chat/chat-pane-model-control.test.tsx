/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerControlsFixture } from "./chat-composer.test-support.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { createTestPageState } from "./chat-page-state.test-support.ts";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";
import { refreshPageChat, retireChatMetadataRequests } from "./chat-state-refresh.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

afterEach(cleanupSolid);

it.each([true, false])(
  "retains the selection when catalog arrives before history (default: %s)",
  async (inherited) => {
    const saved = { id: "saved", provider: "openai", name: "Saved model" };
    const catalog = {
      models: [saved, { id: "default", provider: "openai", name: "Default model" }],
    };
    const agentsList: AgentsListResult = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", model: { primary: inherited ? "openai/saved" : "openai/default" } }],
    };
    const history = Promise.withResolvers<ChatHistoryResult>();
    const client = createTestGatewayClient(async (method) =>
      method === "models.list" ? catalog : method === "chat.startup" ? history.promise : {},
    );
    const harness = createGatewayHarness(client);
    const sessions = createTestSessionCapability(harness.gateway, "main");
    const sessionKey = "agent:main:restored";
    const state = createTestPageState({
      client,
      sessions,
      sessionKey,
      connected: true,
      assistantAgentId: "main",
      agentsList,
      chatMessagesBySession: new Map(),
    });
    cacheChatSessionSnapshot(
      state.chatMessagesBySession,
      state,
      { sessionKey },
      {
        messages: [],
        pagination: { hasMore: false },
        sessionId: "session",
        composer: saved,
      },
    );
    try {
      const pending = refreshPageChat(state, {
        startup: true,
        awaitHistory: true,
        scheduleScroll: false,
      });
      await vi.waitFor(() => expect(state.chatModelCatalog).toEqual(catalog.models));
      expect(
        readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey })?.composer,
      ).toEqual(saved);
      history.resolve({
        sessionId: "session",
        sessionInfo: {
          key: sessionKey,
          sessionId: "session",
          kind: "direct",
          updatedAt: 1,
          ...(inherited ? {} : { model: "saved", modelProvider: "openai" }),
        },
        defaults: { model: "saved", modelProvider: "openai", contextTokens: 8192 },
        messages: [],
        hasMore: false,
        metadata: { commands: [] },
      });
      await pending;
      await vi.waitFor(() =>
        expect(
          readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey })?.composer
            ?.name,
        ).toBe("Saved model"),
      );
    } finally {
      retireChatMetadataRequests(state);
      sessions.dispose();
    }
  },
);

it("presents the saved selection before admission and replaces it with the live catalog", async () => {
  const saved = { id: "saved", provider: "openai", name: "Saved model" };
  const [model, setModel] = createSignal<Parameters<typeof ChatPaneModelControl>[0]["model"]>({
    ...createComposerControlsFixture().model,
    snapshot: saved,
  });
  const view = mountSolid(() => <ChatPaneModelControl model={model()} />);
  const trigger = () => view.container.querySelector<HTMLElement>("[data-chat-model-select]");
  await waitForSolid(() => expect(trigger()?.textContent).toContain("Saved model"));
  expect(trigger()?.getAttribute("aria-disabled")).toBe("true");
  expect(view.container.querySelector("[data-composer-catalog-state=stale]")).not.toBeNull();
  setModel({
    ...createComposerControlsFixture().model,
    snapshot: undefined,
    connected: true,
    gatewayAvailable: true,
    modelCatalog: [{ id: "live", provider: "openai", name: "Live model" }],
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    selectedSession: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      model: "live",
      modelProvider: "openai",
    },
  });
  await waitForSolid(() => expect(trigger()?.textContent).toContain("Live model"));
  expect(view.container.querySelector("[data-composer-catalog-state=stale]")).toBeNull();
});
