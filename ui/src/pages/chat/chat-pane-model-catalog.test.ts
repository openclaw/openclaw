/* @vitest-environment jsdom */

import { createComponent, createMemo } from "solid-js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { UsersListModelAccountsResult } from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogResult } from "../../api/types.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  subscribeChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import { resolveChatModelSelectState } from "../../lib/chat/model-select-state.ts";
import {
  beginModelCatalogRead,
  invalidateModelCatalogCache,
  modelCatalogEventInvalidation,
  publishModelCatalogResult,
} from "../../lib/model-catalog-cache.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { installModelPickerLayout } from "../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost, makeRequestMock } from "./chat-host.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderPaneModelControl } from "./chat-pane-model-control.test-support.ts";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  applyChatModelCatalogSnapshot,
  refreshChatMetadata,
  refreshChatModelCatalogOnDemand,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { expandModelProviders } from "./components/chat-model-picker.test-support.tsx";

beforeEach(installModelPickerLayout);

function seedCatalog(
  client: Parameters<typeof beginModelCatalogRead>[0],
  sessionKey: string,
  catalog: ModelCatalogResult,
) {
  const scope = { agentId: "main", sessionKey };
  expect(publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, catalog)).toBe(
    true,
  );
  return scope;
}

const menuReady = (container: HTMLElement) =>
  waitForSolid(() => expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull());

function composerControls(state: ChatPageHost) {
  return renderChatPaneComposerControls({
    state,
    selectedSession: selectedChatSessionRow(state),
    agentDefaultModel: undefined,
    modelAccess: { allowed: true, requiredScope: "operator.write" },
    effortAccess: { allowed: true, requiredScope: "operator.write" },
    contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
    permissionAccess: { allowed: true, requiredScope: "operator.write" },
    canSelectFull: true,
    onModelSetup: vi.fn(),
  }).composerControls;
}

function mountPicker(state: ChatPageHost, manualRefresh = false, cleanup?: () => void) {
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(
    () => {
      const model = createMemo(() => ({
        ...composerControls(state).model,
        ...(manualRefresh ? { onModelPickerOpen: undefined } : {}),
      }));
      return createComponent(ChatPaneModelControl, {
        get model() {
          return model();
        },
      });
    },
    { container },
  );
  onTestFinished(() => {
    view.unmount();
    container.remove();
    cleanup?.();
    retireChatMetadataRequests(state);
    state.sessions.dispose();
  });
  return container;
}

describe("chat pane composer controls", () => {
  const cachedModels = [{ id: "cached-model", name: "Cached Model", provider: "openai" }];
  it.each(["metadata", "picker"] as const)(
    "retains model selection through a blip, fences late %s reads, and clears on client replacement",
    async (kind) => {
      const original: ModelCatalogResult = {
        models: [{ id: "mock-1", name: "Mock 1", provider: "test", available: true }],
        modelSelectionPolicy: { restricted: true, defaultModel: "test/mock-1" },
        accountSelection: { kind: "personal", label: "Personal", authProfileId: "test:personal" },
      };
      const stale = createDeferred<ModelCatalogResult>();
      const refreshed = createDeferred<ModelCatalogResult>();
      const store = createGatewayStoreTestStore();
      store.gateway.start();
      let reads = 0;
      const request = makeRequestMock({
        "models.list": () =>
          ++reads === 1 ? original : reads === 2 ? stale.promise : refreshed.promise,
        "chat.metadata": { commands: [] },
        "chat.startup": { messages: [], metadata: { commands: [] } },
        "chat.history": { messages: [] },
        "sessions.list": createSessionsListResult(),
        "agents.list": makeBootRoster(),
      });
      store.current().request.mockImplementation(async (method, params) => request(method, params));
      const hello = {
        ...gatewayHelloForMethods(["chat.metadata", "chat.startup", "models.list"]),
        snapshot: {
          presence: [
            { ts: 1, instanceId: store.current().instanceId, user: { id: "catalog-user" } },
          ],
        },
      };
      store.current().testOptions.onHello?.(hello);
      const client = store.gateway.snapshot.client!;
      const { pane, state } = createTestChatPane({ client });
      pane.context = { ...pane.context, gateway: store.gateway };
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      state.chatModelSwitchPromises = {};
      pane.applyGatewaySnapshot(store.gateway.snapshot);
      const unsubscribe = store.gateway.subscribe((snapshot) =>
        pane.applyGatewaySnapshot(snapshot),
      );
      onTestFinished(() => {
        unsubscribe();
        store.gateway.stop();
      });
      const selection = () =>
        resolveChatModelSelectState({
          sessionKey: state.sessionKey,
          sessionsResult: null,
          modelOverrides: { [state.sessionKey]: "test/mock-1" },
          chatModelCatalog: state.chatModelCatalog,
          modelSelectionPolicy: state.chatModelSelectionPolicy,
          catalogInitialized: state.chatModelCatalogInitialized,
        });
      const expectOriginal = () => {
        expect(state.chatModelCatalog).toEqual(original.models);
        expect(state.chatModelSelectionPolicy).toEqual(original.modelSelectionPolicy);
        expect(state.chatAccountSelection).toEqual(original.accountSelection);
        expect(selection()).toMatchObject({
          currentOverride: "test/mock-1",
          defaultLabel: "Default (Mock 1)",
          options: [{ value: "test/mock-1", label: "Mock 1" }],
        });
      };
      await refreshChatMetadata(state);
      expectOriginal();
      invalidateModelCatalogCache(client);
      const pending =
        kind === "picker" ? refreshChatModelCatalogOnDemand(state) : refreshChatMetadata(state);
      expect(reads).toBe(2);

      store
        .current()
        .testOptions.onClose?.({ code: 1006, reason: "network unavailable", willRetry: true });
      await refreshChatMetadata(state);
      expectOriginal();
      expect(composerControls(state).model.modelCatalogState.status).toBe("offline");
      expect(state.chatModelsLoading).toBe(false);
      const readsBeforeReconnect = reads;
      store.current().testOptions.onHello?.(hello);
      await waitForFast(() => expect(reads).toBe(readsBeforeReconnect + 1));
      expectOriginal();
      stale.resolve({
        models: [{ ...original.models[0]!, available: false, unavailableReason: "missing-auth" }],
        accountSelection: { kind: "shared", label: "Old account", authProfileId: "test:old" },
      });
      await pending;
      expectOriginal();

      const fresh = {
        ...original,
        models: [{ ...original.models[0]!, name: "Fresh Mock 1" }],
      };
      refreshed.resolve(fresh);
      await waitForFast(() => expect(state.chatModelCatalog).toEqual(fresh.models));
      expect(selection().defaultLabel).toBe("Default (Fresh Mock 1)");
      expect(selection().options).toEqual([{ value: "test/mock-1", label: "Fresh Mock 1" }]);
      expect(state.chatModelCatalogError).toBeNull();

      store.gateway.connect();
      expect(state.chatModelCatalog).toEqual([]);
      expect(state.chatModelCatalogInitialized).toBe(false);
      expect(state.chatModelSelectionPolicy).toBeUndefined();
      expect(state.chatAccountSelection).toBeNull();
      expect(selection().defaultLabel).toBe("Default model");
      expect(selection().options).toEqual([]);
    },
  );

  it("keeps a natively dismissed model picker closed when account loading settles", async () => {
    const accounts = createDeferred<UsersListModelAccountsResult>();
    const request = makeRequestMock({
      "models.list": () => ({
        models: cachedModels,
        accountSelection: {
          kind: "personal",
          label: "Personal workspace",
          authProfileId: "openai:personal",
        },
      }),
      "users.listModelAccounts": () => accounts.promise,
    });
    const { state } = createRefreshChatPane(createTestGatewayClient(request));
    state.sessionKey = "agent:main:main";
    state.sessionsResult = createSessionsListResult({
      defaultsModel: "cached-model",
      defaultsProvider: "openai",
    });
    await refreshChatModelCatalogOnDemand(state);
    state.chatModelPickerOpenSessionKey = state.sessionKey;
    const container = mountPicker(state);
    flush();
    const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker")!;
    expect(picker.open).toBe(true);
    await menuReady(container);
    container.querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")!.click();
    flush();
    expect(container.querySelector('[data-chat-account-option="loading"]')).not.toBeNull();

    container.querySelector<HTMLElement>("[data-chat-model-select]")!.click();
    flush();
    expect(picker.open).toBe(false);
    accounts.resolve({ profileId: "owner", links: [], accounts: [] });
    await waitForSolid(() =>
      expect(container.querySelector('[data-chat-account-option="loading"]')).toBeNull(),
    );
    expect(picker.open).toBe(false);
  });

  it.each([
    { entry: "direct", retained: false },
    { entry: "direct", retained: true },
    { entry: "automatic", retained: false },
    { entry: "automatic", retained: true },
  ])(
    "rechecks a failed $entry catalog with retained models $retained",
    async ({ entry, retained }) => {
      const checking = createDeferred<ModelCatalogResult>();
      const request = makeRequestMock({ "models.list": () => checking.promise });
      const client = createTestGatewayClient(request);
      const { state } = createRefreshChatPane(client);
      state.sessionKey = "agent:main:main";
      state.chatModelCatalogInitialized = false;
      state.chatModelPickerOpenSessionKey = state.sessionKey;
      // The test owns refresh admission; opening only exposes the live state.
      const container = mountPicker(state, true, () => checking.resolve({ models: [] }));
      if (retained) {
        const scope = seedCatalog(client, state.sessionKey, { models: cachedModels });
        await refreshChatModelCatalogOnDemand(state);
        invalidateModelCatalogCache(client, scope);
      }
      request.mockRejectedValueOnce(new Error("Previous runtime preparation failed"));
      await refreshChatModelCatalogOnDemand(state);
      expect(state.chatModelCatalogError).toContain("Previous runtime preparation failed");
      expect(state.chatModelCatalog).toEqual(retained ? cachedModels : []);
      const failureLabel = retained
        ? "Some models could not be refreshed. Open Models to try again."
        : "Models unavailable";
      await menuReady(container);
      expandModelProviders(container);
      expect(container.textContent).toContain(failureLabel);

      const refresh =
        entry === "automatic" ? refreshChatMetadata(state) : refreshChatModelCatalogOnDemand(state);
      expect(applyChatModelCatalogSnapshot(state)).toBe(false);
      flush();
      expect(state.chatModelsLoading).toBe(true);
      expect(container.querySelector('[data-chat-model-catalog-state="error"]')).toBeNull();
      expect(container.querySelector(".btn__spinner")).not.toBeNull();
      expect(container.textContent).not.toContain(failureLabel);
      if (retained) {
        expect(container.querySelector("[data-chat-model-refresh]")).not.toBeNull();
        expect(container.textContent).toContain("Refreshing models…");
        expect(
          container.querySelector<HTMLButtonElement>("[data-chat-model-option]")?.disabled,
        ).toBe(false);
        expect(container.textContent).toContain("Cached Model");
      } else {
        expect(container.querySelector('[data-chat-model-catalog-state="loading"]')).not.toBeNull();
        expect(container.textContent).toContain("Loading models…");
      }

      checking.reject(new Error("Runtime preparation still failed"));
      await refresh;
      flush();
      expect(container.querySelector('[data-chat-model-catalog-state="error"]')).not.toBeNull();
      expect(container.textContent).toContain(failureLabel);
      expect(container.querySelector(".btn__spinner")).toBeNull();
      expect(container.textContent).not.toContain("Loading models…");
      expect(state.chatModelCatalogError).toContain("Runtime preparation still failed");

      request.mockResolvedValueOnce({ models: cachedModels });
      await refreshChatModelCatalogOnDemand(state);
      flush();
      expandModelProviders(container);
      expect(container.textContent).toContain("Cached Model");
      expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
    },
  );

  it.each<{ label: string; cachedCatalog?: ModelCatalogResult }>([
    {
      label: "warm restricted",
      cachedCatalog: {
        models: cachedModels,
        modelSelectionPolicy: { restricted: true, defaultModel: "openai/cached-model" },
      },
    },
    { label: "cold" },
  ])(
    "revalidates the $label configured model catalog when the picker opens",
    async ({ cachedCatalog }) => {
      const container = document.body.appendChild(document.createElement("div"));
      const catalog = createDeferred<ModelCatalogResult>();
      const session: GatewaySessionRow = {
        key: "main",
        agentId: "main",
        sessionId: "picker-session",
        kind: "direct",
        updatedAt: 1,
        contextTokens: 8192,
      };
      const request = vi.fn((method: string) =>
        method === "sessions.describe"
          ? Promise.resolve({ session: { ...session, contextTokens: 262144 } })
          : catalog.promise,
      );
      const client = createTestGatewayClient(request);
      const state = makeChatHost({
        client,
        connectionEpoch: 1,
        sessionKey: "main",
        sessionsResult: { ...createSessionsListResult(), sessions: [session] },
      }) as unknown as ChatPageHost;
      state.chatModelSwitchPromises = {};
      onTestFinished(() => {
        container.remove();
        retireChatMetadataRequests(state);
        state.sessions.dispose();
      });
      if (cachedCatalog) {
        const scope = seedCatalog(client, "main", cachedCatalog);
        const initialized = refreshChatModelCatalogOnDemand(state);
        expect(state.chatModelCatalogInitialized).toBe(true);
        expect(state.chatModelSelectionPolicy).toEqual(cachedCatalog.modelSelectionPolicy);
        expect(state.chatModelCatalog).toEqual(cachedCatalog.models);
        expect(request).not.toHaveBeenCalled();
        await initialized;
        await refreshChatModelCatalogOnDemand(state);
        invalidateModelCatalogCache(client, scope);
      }
      renderPaneModelControl(composerControls(state), container);

      const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
      picker!.open = true;
      picker!.dispatchEvent(new Event("toggle"));

      expect(state.chatModelPickerOpenSessionKey).toBe("main");
      expect(request).toHaveBeenCalledWith("models.list", {
        view: "configured",
        agentId: "main",
        sessionKey: "main",
      });
      expect(state.chatModelsLoading).toBe(!cachedCatalog);
      const freshModels = [{ id: "fresh-model", name: "Fresh Model", provider: "openai" }];
      catalog.resolve({
        models: freshModels,
        ...(cachedCatalog?.modelSelectionPolicy
          ? { modelSelectionPolicy: { restricted: true, defaultModel: "openai/fresh-model" } }
          : {}),
      });
      await vi.waitFor(() => expect(state.chatModelCatalog).toEqual(freshModels));
      await vi.waitFor(() => expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(262144));
    },
  );

  it("retains the current catalog after sign-in while the replacement is held", async () => {
    const startup = createDeferred<unknown>();
    const catalog = createDeferred<unknown>();
    const client = createTestGatewayClient(
      makeRequestMock({
        "chat.startup": () => startup.promise,
        "models.list": () => catalog.promise,
      }),
    );
    const { state: host } = createRefreshChatPane(client);
    host.sessionKey = "agent:main";
    host.hello = gatewayHelloForMethods(["chat.metadata", "chat.startup"], []);
    onTestFinished(() => retireChatMetadataRequests(host));
    const cachedModel = {
      available: true,
      id: "cached-model",
      name: "Cached Model",
      provider: "openai",
    };
    const scope = { agentId: "main", sessionKey: host.sessionKey };
    const release = subscribeChatMetadata(client, scope, () => {});
    beginChatMetadataPublication(client, scope).publish({
      commands: [],
    });
    seedCatalog(client, host.sessionKey, { models: [cachedModel] });
    await refreshChatModelCatalogOnDemand(host);
    invalidateChatMetadataStore(
      client,
      undefined,
      undefined,
      modelCatalogEventInvalidation({ event: "config.changed" }),
    );
    const refresh = refreshPageChat(host, {
      awaitHistory: true,
      deferBranches: true,
      startup: true,
    });
    release();

    expect(host.chatModelCatalog).toEqual([cachedModel]);
    expect(host.chatModelsLoading).toBe(false);

    startup.resolve({
      messages: [],
      metadata: {
        commands: [],
      },
    });
    catalog.resolve({ models: [{ ...cachedModel, id: "fresh-model", name: "Fresh Model" }] });
    await expect(refresh).resolves.toBeUndefined();
    await waitForFast(() =>
      expect(host.chatModelCatalog).toEqual([
        { ...cachedModel, id: "fresh-model", name: "Fresh Model" },
      ]),
    );
  });
});
