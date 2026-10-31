/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerControlsFixture } from "./chat-composer.test-support.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";
import { makeChatPageHost } from "./chat-pending-inputs.test-support.ts";
import { refreshPageChat, retireChatMetadataRequests } from "./chat-state-refresh.ts";
import * as catalogPresentation from "./components/chat-model-catalog-presentation.ts";
import { cacheChatSessionSnapshot, readChatSessionSnapshot } from "./session-message-cache.ts";

const saved = { id: "saved", provider: "openai", name: "Saved model" };
const sessionKey = "agent:main:restored";

afterEach(() => vi.restoreAllMocks());

it("reuses the saved catalog across unrelated frames and refreshes changed model facts", async () => {
  const prepare = vi.spyOn(catalogPresentation, "prepareChatModelCatalog");
  const initial = {
    ...createComposerControlsFixture().model,
    snapshot: { id: "saved", provider: "openai", name: "Saved model" },
  };
  const [model, setModel] = createSignal(initial);
  const view = mountSolid(() => <ChatPaneModelControl model={model()} />);
  const trigger = () => view.container.querySelector<HTMLElement>("[data-chat-model-select]");
  await waitForSolid(() => expect(trigger()?.textContent).toContain("Saved model"));
  const prepared = prepare.mock.calls.length;

  setModel({ ...initial, loading: !initial.loading });
  flush();
  expect(prepare).toHaveBeenCalledTimes(prepared);
  expect(trigger()?.getAttribute("aria-disabled")).toBe("true");

  setModel({ ...initial, snapshot: { ...initial.snapshot, name: "Updated saved model" } });
  await waitForSolid(() => expect(trigger()?.textContent).toContain("Updated saved model"));
  expect(prepare.mock.calls.length).toBeGreaterThan(prepared);
});

it.each([
  { inherited: true, supported: false, tiers: ["default"], speed: "Standard", active: false },
  {
    inherited: false,
    supported: true,
    tiers: ["default", "priority"],
    speed: "Fast",
    active: true,
  },
])(
  "retains selection and effective speed before history ($speed)",
  async ({ inherited, supported, tiers, speed: expectedSpeed, active }) => {
    const catalog = {
      models: [
        {
          ...saved,
          supportsFastMode: supported,
          supportsServiceTierRecovery: true,
          serviceTiers: tiers,
        },
        { id: "default", provider: "openai", name: "Default model" },
      ],
    };
    const history = Promise.withResolvers<ChatHistoryResult>();
    const state = makeChatPageHost({
      requestHandlers: { "models.list": catalog, "chat.startup": () => history.promise },
      sessionKey,
      assistantAgentId: "main",
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", model: { primary: inherited ? "openai/saved" : "openai/default" } }],
      },
    });
    const composer = () =>
      readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey })?.composer;
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
      expect(composer()).toEqual(saved);
      history.resolve({
        sessionId: "session",
        sessionInfo: {
          key: sessionKey,
          sessionId: "session",
          kind: "direct",
          updatedAt: 1,
          fastMode: "ultrafast",
          ...(inherited ? {} : { model: "saved", modelProvider: "openai" }),
        },
        defaults: { model: "saved", modelProvider: "openai", contextTokens: 8192 },
        messages: [],
        hasMore: false,
        metadata: { commands: [] },
      });
      await pending;
      await vi.waitFor(() => expect(composer()?.name).toBe("Saved model"));
      const remembered = composer();
      const liveModel = {
        ...createComposerControlsFixture().model,
        connected: true,
        gatewayAvailable: true,
        sessionKey,
        modelCatalog: catalog.models,
        modelCatalogState: { hasSnapshot: true, status: "ready" as const },
        selectedSession: state.sessionsResult?.sessions[0],
        fastModeTarget: state.sessionsResult?.sessions[0],
        sessionsResult: state.sessionsResult,
      };
      const [model, setModel] = createSignal<Parameters<typeof ChatPaneModelControl>[0]["model"]>({
        ...liveModel,
        snapshot: remembered ?? undefined,
      });
      const view = mountSolid(() => <ChatPaneModelControl model={model()} />);
      const speed = () => view.container.querySelector("[data-chat-fast-mode]");
      await waitForSolid(() =>
        expect(speed()?.getAttribute("aria-label")).toContain(expectedSpeed),
      );
      expect(speed()?.getAttribute("data-chat-fast-mode")).toBe(String(active));
      setModel(liveModel);
      await waitForSolid(() =>
        expect(speed()?.getAttribute("aria-label")).toContain(expectedSpeed),
      );
      expect(speed()?.getAttribute("data-chat-fast-mode")).toBe(String(active));
    } finally {
      retireChatMetadataRequests(state);
      state.sessions.dispose();
    }
  },
);

it("presents the saved selection before admission and replaces it with the live catalog", async () => {
  const savedWithEffort = {
    id: "saved",
    provider: "openai",
    name: "Saved model",
    reasoning: true,
    thinkingLevel: "high",
    thinkingDefault: "medium",
    thinkingLevels: [{ id: "high", label: "High" }],
  };
  const [model, setModel] = createSignal<Parameters<typeof ChatPaneModelControl>[0]["model"]>({
    ...createComposerControlsFixture().model,
    snapshot: savedWithEffort,
  });
  const view = mountSolid(() => <ChatPaneModelControl model={model()} />);
  const trigger = () => view.container.querySelector<HTMLElement>("[data-chat-model-select]");
  await waitForSolid(() => expect(trigger()?.textContent).toContain("Saved model"));
  expect(trigger()?.getAttribute("aria-disabled")).toBe("true");
  const effort = () => view.container.querySelector<HTMLElement>("[data-chat-thinking-select]");
  expect(effort()?.textContent).toContain("High");
  expect(effort()?.getAttribute("aria-disabled")).toBe("true");
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
