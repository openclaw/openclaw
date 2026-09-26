/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogResult } from "../../api/types.ts";
import { invalidateChatMetadataStore } from "../../lib/chat/chat-metadata-cache.ts";
import {
  beginChatMetadataPublication,
  subscribeChatMetadata,
} from "../../lib/chat/chat-metadata-store.ts";
import {
  beginModelCatalogRead,
  invalidateModelCatalogCache,
  modelCatalogEventInvalidation,
  publishModelCatalogResult,
} from "../../lib/model-catalog-cache.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { makeChatHost, makeRequestMock } from "./chat-host.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  refreshChatModelCatalogOnDemand,
  refreshPageChat,
  retireChatMetadataRequests,
} from "./chat-state-refresh.ts";

describe("chat pane composer controls", () => {
  const cachedModels = [{ id: "cached-model", name: "Cached Model", provider: "openai" }];
  it.each<{ label: string; cachedCatalog?: ModelCatalogResult }>([
    {
      label: "warm",
      cachedCatalog: { models: cachedModels },
    },
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
      const container = document.createElement("div");
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
        requestUpdate: vi.fn(),
      }) as unknown as ChatPageHost;
      state.chatModelSwitchPromises = {};
      onTestFinished(() => {
        retireChatMetadataRequests(state);
        state.sessions.dispose();
      });
      if (cachedCatalog) {
        const scope = { agentId: "main", sessionKey: "main" };
        expect(
          publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, cachedCatalog),
        ).toBe(true);
        const initialized = refreshChatModelCatalogOnDemand(state);
        expect(state.chatModelCatalogInitialized).toBe(true);
        expect(state.chatModelSelectionPolicy).toEqual(cachedCatalog.modelSelectionPolicy);
        expect(state.chatModelCatalog).toEqual(cachedCatalog.models);
        expect(request).not.toHaveBeenCalled();
        await initialized;
        invalidateModelCatalogCache(client, scope);
      }
      const controlParams = {
        state,
        selectedSession: undefined,
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" } as const,
        effortAccess: { allowed: true, requiredScope: "operator.write" } as const,
        contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
        permissionAccess: { allowed: true, requiredScope: "operator.write" } as const,
        canSelectFull: true,
        onModelSetup: vi.fn(),
      };
      render(renderChatPaneComposerControls(controlParams).composerControls, container);

      const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
      picker!.open = true;
      picker!.dispatchEvent(new Event("toggle"));

      expect(state.chatModelPickerOpenSessionKey).toBe("main");
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith("models.list", {
        view: "configured",
        agentId: "main",
        sessionKey: "main",
      });
      expect(state.chatModelsLoading).toBe(!cachedCatalog);
      render(renderChatPaneComposerControls(controlParams).composerControls, container);
      if (cachedCatalog) {
        expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
        expect(
          container.querySelector<HTMLButtonElement>("[data-chat-model-option]")?.disabled,
        ).toBe(false);
        expect(container.textContent).toContain("Cached Model");
      } else {
        expect(container.querySelector('[data-chat-model-catalog-state="loading"]')).not.toBeNull();
        expect(container.textContent).toContain("Loading models…");
      }
      const freshModels = [{ id: "fresh-model", name: "Fresh Model", provider: "openai" }];
      catalog.resolve({
        models: freshModels,
        ...(cachedCatalog?.modelSelectionPolicy
          ? { modelSelectionPolicy: { restricted: true, defaultModel: "openai/fresh-model" } }
          : {}),
      });
      await vi.waitFor(() => expect(state.chatModelCatalog).toEqual(freshModels));
      await vi.waitFor(() => expect(state.sessionsResult?.sessions[0]?.contextTokens).toBe(262144));
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "models.list",
        "sessions.describe",
      ]);
    },
  );

  it("keeps current models interactive after sign-in while the replacement catalog is held", async () => {
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
    expect(
      publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, {
        models: [cachedModel],
      }),
    ).toBe(true);
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
    const container = document.createElement("div");
    const controls = renderChatPaneComposerControls({
      state: host,
      selectedSession: undefined,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    });
    render(controls.composerControls, container);
    expect(container.querySelector("[data-chat-model-catalog-state]")).toBeNull();
    expect(container.textContent).toContain("Cached Model");
    expect(container.textContent).not.toContain("Loading models…");

    startup.resolve({
      messages: [],
      metadata: {
        commands: [],
        models: [{ ...cachedModel, id: "fresh-model", name: "Fresh Model" }],
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
