/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ChatAccountSelection,
  UsersListModelAccountsResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import {
  captureChatOutboxAdmission,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { createInitializationContext, createRenderTestChatPane } from "./chat-pane.test-support.ts";
import { steerQueuedChatMessage } from "./chat-send-actions.ts";
import { switchChatModel, switchChatSetting } from "./chat-session.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
import { renderChatPermissionPicker } from "./components/chat-permission-picker.ts";
import { getChatSessionProjection, setChatRunOwner } from "./history-merge.ts";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

type ComposerControlsParams = Parameters<typeof renderChatPaneComposerControls>[0];

function renderControls(
  state: ChatPageHost,
  overrides: Partial<Omit<ComposerControlsParams, "state">> = {},
) {
  return renderChatPaneComposerControls({
    state,
    selectedSession: state.sessionsResult?.sessions[0],
    agentDefaultModel: undefined,
    modelAccess: { allowed: true, requiredScope: "operator.write" },
    effortAccess: { allowed: true, requiredScope: "operator.write" },
    contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
    permissionAccess: { allowed: true, requiredScope: "operator.write" },
    canSelectFull: true,
    onModelSetup: vi.fn(),
    ...overrides,
  });
}

describe("chat account selection", () => {
  function mountAccountControl(
    request: GatewayRequestHandler,
    selection: ChatAccountSelection | null,
  ) {
    const container = document.createElement("div");
    let current = true;
    const state: Pick<ChatPageHost, "client" | "chatAccountSelection" | "requestUpdate"> = {
      client: createTestGatewayClient(request),
      chatAccountSelection: selection,
      requestUpdate: () => draw(),
    };
    const onSelect = vi.fn(async () => true);
    const onManage = vi.fn();
    const draw = () =>
      render(
        renderChatModelAccountControl({
          owner: state,
          client: state.client,
          selection: state.chatAccountSelection,
          model: "openai/gpt-5.5",
          disabled: false,
          ownsSelection: () => current,
          onSelect,
          onManage,
          onRequestUpdate: () => draw(),
        })?.render(0),
        container,
      );
    draw();
    return {
      container,
      state,
      draw,
      onSelect,
      onManage,
      retire: () => {
        current = false;
      },
      open: () =>
        container.querySelector<HTMLButtonElement>("[data-chat-account-group-toggle]")?.click(),
      select: (value: string) => {
        container
          .querySelector<HTMLButtonElement>(`[data-chat-account-option="${value}"]`)
          ?.click();
        return container.querySelector("[data-chat-account-group-toggle]")?.textContent?.trim();
      },
    };
  }

  it("keeps the current chat choice separate from a saved default for new chats", async () => {
    const request = vi.fn().mockResolvedValue({
      profileId: "owner",
      links: [{ provider: "openai", authProfileId: "openai:work", updatedAt: 1 }],
      accounts: [
        {
          authProfileId: "openai:personal",
          provider: "openai",
          label: "Personal workspace",
          authType: "oauth",
          selected: false,
        },
        {
          authProfileId: "openai:work",
          provider: "openai",
          label: "Work workspace",
          authType: "oauth",
          selected: true,
        },
        {
          authProfileId: "anthropic:personal",
          provider: "anthropic",
          label: "Claude account",
          authType: "token",
          selected: true,
        },
      ],
    } satisfies UsersListModelAccountsResult);
    const view = mountAccountControl(request, {
      kind: "personal",
      label: "Personal workspace",
      authProfileId: "openai:personal",
      source: "user",
    });
    expect(request).not.toHaveBeenCalled();
    expect(
      view.container
        .querySelector("[data-chat-account-group-toggle]")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    view.open();
    await vi.waitFor(() => expect(view.container.textContent).toContain("Work workspace"));
    expect(view.container.querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      "Personal workspace",
    );
    expect(view.container.textContent).not.toContain("Claude account");
    expect(view.select("account:openai:work")).toContain("Personal workspace");
    expect(view.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:work", label: "Work workspace" }),
    );
    expect(view.container.querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      "Personal workspace",
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual(["users.listModelAccounts"]);

    view.state.chatAccountSelection = {
      kind: "personal",
      label: "Work workspace",
      authProfileId: "openai:work",
      source: "user",
    };
    view.draw();
    expect(view.container.querySelector("[data-chat-account-group-toggle]")?.textContent).toContain(
      "Work workspace",
    );
    view.select("manage");
    expect(view.onManage).toHaveBeenCalledOnce();
  });

  it("retries a failed inventory when the section is reopened", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("inventory offline"))
      .mockResolvedValueOnce({
        profileId: "owner",
        links: [],
        accounts: [
          {
            authProfileId: "openai:work",
            provider: "openai",
            label: "Work workspace",
            authType: "oauth",
            selected: true,
          },
        ],
      } satisfies UsersListModelAccountsResult);
    const view = mountAccountControl(request, {
      kind: "personal",
      label: "Personal workspace",
      authProfileId: "openai:personal",
      source: "user",
    });
    view.open();
    await vi.waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "inventory offline",
      ),
    );
    view.open();
    view.open();
    await vi.waitFor(() => expect(view.container.textContent).toContain("Work workspace"));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("discards a late inventory after leaving its initiating chat", async () => {
    const pending = createDeferred<UsersListModelAccountsResult>();
    const view = mountAccountControl(() => pending.promise, {
      kind: "personal",
      label: "Collaborator's saved account",
    });
    view.open();
    view.retire();
    pending.resolve({
      profileId: "owner",
      links: [],
      accounts: [
        {
          authProfileId: "openai:old",
          provider: "openai",
          label: "Old connection account",
          authType: "oauth",
          selected: false,
        },
      ],
    });
    await pending.promise;
    view.draw();
    expect(view.container.textContent).not.toContain("Old connection account");
    view.select("account:openai:old");
    expect(view.onSelect).not.toHaveBeenCalled();
  });
});

describe("chat pane composer controls", () => {
  it("renders the selected Gateway model while keeping its model picker locked", () => {
    const selectedSession: GatewaySessionRow = {
      key: "main",
      kind: "direct",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
      modelSelectionLocked: true,
      agentRuntime: { id: "codex", source: "model" },
    };
    const state = makeChatHost({
      sessionKey: selectedSession.key,
      sessionsResult: { ...createSessionsListResult(), sessions: [selectedSession] },
      chatModelCatalog: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" }],
      chatModelSwitchPromises: {},
      requestHandlers: {},
    });
    const controls = renderControls(state as unknown as ChatPageHost, {
      agentDefaultModel: "openai/gpt-5.6-luna",
    });
    const container = document.createElement("div");
    render(controls.composerControls, container);

    const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]");
    expect(trigger?.textContent).toContain("GPT-5.6 Sol");
    expect(trigger?.getAttribute("aria-label")).toBe("Chat model: GPT-5.6 Sol");
    expect(trigger?.dataset.chatModelLocked).toBe("true");
    expect(container.querySelector(".chat-controls__locked-model-value")?.textContent).toBe(
      "GPT-5.6 Sol",
    );
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
    expect(state.request).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty", cached: false, connected: true, error: null, message: "No models available" },
    {
      label: "offline",
      cached: true,
      connected: false,
      error: "metadata unavailable",
      message: "Offline",
    },
    {
      label: "failed with a snapshot",
      cached: true,
      error: "metadata unavailable",
      message: "Some models could not be refreshed. Open Models to try again.",
    },
    {
      label: "failed without a snapshot",
      cached: false,
      error: "metadata unavailable",
      message: "Models unavailable",
    },
  ])(
    "renders separate footer inputs with a $label catalog",
    ({ cached, connected = true, error, message }) => {
      const container = document.createElement("div");
      const state = makeChatHost({
        connected,
        requestHandlers: {},
        chatModelCatalog: cached
          ? [{ id: "cached-model", name: "Cached Model", provider: "openai", available: false }]
          : [],
        chatModelSwitchPromises: {},
        sessionKey: "main",
      }) as unknown as ChatPageHost;
      state.chatModelCatalogError = error;
      const onModelSetup = vi.fn();

      const controls = renderControls(state, {
        agentDefaultPermissionMode: "guarded",
        onModelSetup,
      });
      render(controls.composerControls, container);

      expect(Array.from(container.children).map((node) => node.className)).toEqual([
        "chat-composer-model-control",
      ]);
      expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
      expect(container.querySelector('[data-chat-permission-select="true"]')).toBeNull();
      const catalogMessage = container.querySelector(".chat-controls__model-catalog-state");
      expect(catalogMessage?.textContent).toContain(message);
      expect(
        container.querySelector('[data-chat-model-select="true"]')?.getAttribute("aria-disabled"),
      ).toBe(String(!connected));
      expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(cached ? 1 : 0);
      const permissionContainer = document.createElement("div");
      render(renderChatPermissionPicker(controls.permissionPicker), permissionContainer);
      expect(
        permissionContainer.querySelector('[data-chat-permission-select="true"]'),
      ).not.toBeNull();
      expect(
        permissionContainer
          .querySelector('[data-chat-permission-select="true"]')
          ?.getAttribute("aria-label"),
      ).toContain("Default (Guarded)");
      container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
      expect(onModelSetup).toHaveBeenCalledTimes(error ? 0 : 1);
    },
  );

  it("patches a rootless session, clears to default, and locks full access", async () => {
    const container = document.createElement("div");
    const selectedSession: GatewaySessionRow = {
      key: "agent:main:permission-test",
      kind: "direct",
      permissionMode: "full",
      sessionId: "permission-test-session",
    };
    const state = makeChatHost({
      requestHandlers: {},
      hello: sessionMutationGatewayHello(["operator.write"]),
      chatModelSwitchPromises: {},
      sessionKey: selectedSession.key,
      sessionsResult: { ...createSessionsListResult(), sessions: [selectedSession] },
    }) as unknown as ChatPageHost;
    const patch = vi.spyOn(state.sessions, "patch").mockResolvedValue({
      ok: true,
      path: "",
      key: selectedSession.key,
      entry: { sessionId: "permission-test-session" },
    } satisfies SessionPatchResult);

    const controls = renderControls(state, {
      agentDefaultPermissionMode: "guarded",
      canSelectFull: false,
    });
    render(renderChatPermissionPicker(controls.permissionPicker), container);

    const heading = container.querySelector<HTMLElement>(".chat-controls__permission-heading");
    expect(heading?.textContent?.trim()).toBe("Execution permissions");
    expect(heading?.closest("wa-dropdown-item")).toBeNull();
    const docsLink = container.querySelector<HTMLElement>(
      "wa-dropdown > wa-dropdown-item.chat-controls__permission-learn-more",
    );
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.getAttribute("href")).toBe(
      "https://docs.openclaw.ai/gateway/permission-modes",
    );
    expect(docsLink?.getAttribute("target")).toBe("_blank");
    const rel = docsLink?.getAttribute("rel")?.split(/\s+/).toSorted();
    expect(rel).toEqual(["noopener", "noreferrer"]);

    const dropdown = container.querySelector<HTMLElement>(".chat-controls__permission-picker");
    dropdown?.setAttribute("open", "");
    const full = container.querySelector<HTMLElement>('[data-chat-permission-option="full"]');
    const defaultOption = container.querySelector<HTMLElement>(
      '[data-chat-permission-option="default"]',
    );
    expect(defaultOption?.textContent).toContain(
      "Follow the agent's configured execution permissions.",
    );
    expect(defaultOption?.textContent).toContain("Default (Guarded)");
    expect(
      container.querySelector('[data-chat-permission-select="true"]')?.getAttribute("aria-label"),
    ).toBe("Execution permissions: Full Access");
    expect(full?.hasAttribute("disabled")).toBe(true);
    expect(full?.getAttribute("aria-checked")).toBe("true");
    expect(full?.querySelector(".chat-controls__permission-shortcut")).toBeNull();
    expect(full?.querySelector(".chat-controls__permission-lock")).not.toBeNull();
    expect(full?.querySelector(".chat-controls__inline-select-check")).toBeNull();
    expect(full?.getAttribute("aria-label")).toContain("operator.admin");

    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    await vi.waitFor(() =>
      expect(getPendingChatPickerPatch(state, state.sessionKey)).toBeUndefined(),
    );
    expect(patch).toHaveBeenCalledWith(
      selectedSession.key,
      { permissionMode: "guarded" },
      expect.objectContaining({ agentId: undefined, expectedSessionId: "permission-test-session" }),
    );

    dropdown?.setAttribute("open", "");
    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenLastCalledWith(
      selectedSession.key,
      { permissionMode: null },
      expect.objectContaining({ agentId: undefined, expectedSessionId: "permission-test-session" }),
    );
  });

  it("patches an identity-less session while its first identity materializes", async () => {
    const patchResult = createDeferred<SessionPatchResult>();
    const key = "agent:main:first-materialization";
    const selectedSession = { key, kind: "direct" as const, permissionMode: "guarded" as const };
    const state = makeChatHost({
      connectionEpoch: 1,
      requestHandlers: {},
      sessionKey: key,
      sessionsResult: {
        ...createSessionsListResult({ defaultsModel: null, defaultsProvider: null }),
        sessions: [selectedSession],
      },
      chatModelSwitchPromises: {},
    }) as unknown as ChatPageHost;
    const patch = vi.spyOn(state.sessions, "patch").mockImplementation(() => patchResult.promise);
    const controls = renderControls(state);

    expect(controls.permissionPicker.disabled).toBe(false);
    const selection = controls.permissionPicker.onSelect("workspace");
    await vi.waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        key,
        { permissionMode: "workspace" },
        expect.objectContaining({ expectedSessionId: undefined }),
      ),
    );
    state.sessionsResult = {
      defaults: {},
      sessions: [{ ...selectedSession, permissionMode: "workspace", sessionId: "materialized" }],
    } as ChatPageHost["sessionsResult"];
    patchResult.resolve({ ok: true, path: "", key, entry: { sessionId: "materialized" } });
    await selection;

    expect(state.chatError).toBeNull();
  });

  it.each([
    {
      label: "successful update after switching sessions",
      result: "success",
      invalidate: (state: ChatPageHost) => {
        state.sessionKey = "agent:main:other-session";
      },
    },
    {
      label: "failed update after switching sessions",
      result: "failure",
      invalidate: (state: ChatPageHost) => {
        state.sessionKey = "agent:main:other-session";
      },
    },
    {
      label: "successful global-session update after switching agents",
      result: "success",
      initialSessionKey: "global",
      invalidate: (state: ChatPageHost) => {
        state.assistantAgentId = "research";
      },
    },
    {
      label: "successful update after reconnecting",
      result: "success",
      invalidate: (state: ChatPageHost) => {
        state.connectionEpoch += 1;
      },
    },
    {
      label: "successful update after replacing the Gateway client",
      result: "success",
      invalidate: (state: ChatPageHost) => {
        state.client = {} as ChatPageHost["client"];
      },
    },
  ] as const)("suppresses alerts for a $label", async (lifecycleCase) => {
    const { invalidate, result } = lifecycleCase;
    const pending = createDeferred<SessionPatchResult>();
    const sessionKey =
      "initialSessionKey" in lifecycleCase
        ? (lifecycleCase.initialSessionKey ?? "agent:main:remote-worker")
        : "agent:main:remote-worker";
    const selectedSession: GatewaySessionRow = {
      key: sessionKey,
      kind: "direct",
      hasActiveRun: true,
      sessionId: "lifecycle-session",
    };
    const state = makeChatHost({
      assistantAgentId: "main",
      chatRunId: "remote-worker-run",
      chatError: null,
      connectionEpoch: 1,
      requestHandlers: {},
      chatModelSwitchPromises: {},
      sessionKey,
      sessionsResult: { ...createSessionsListResult(), sessions: [selectedSession] },
      requestUpdate: vi.fn(),
    }) as unknown as ChatPageHost;
    const patch = vi.spyOn(state.sessions, "patch").mockImplementation(() => pending.promise);
    const controls = renderControls(state);

    const selection = controls.permissionPicker.onSelect("full");
    expect(patch).toHaveBeenCalledOnce();
    invalidate(state);
    if (result === "failure") {
      pending.reject(new Error("original remote worker disconnected"));
    } else {
      pending.resolve({
        ok: true,
        path: "",
        key: sessionKey,
        entry: { sessionId: "lifecycle-session" },
      });
    }
    await selection;

    expect(state.chatError).toBeNull();
  });
});

describe("chat pane model controls", () => {
  it("keeps the preference visible while admitted events update execution metadata", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:current",
      kind: "direct",
      sessionId: "current-session",
      updatedAt: 1,
      model: "primary",
      modelProvider: "example",
      hasActiveRun: true,
      activeModel: "fallback",
      activeModelProvider: "example",
    };
    const steerAck = createDeferred<unknown>();
    const request = createGatewayRequestMock((method) => {
      if (method === "sessions.list") {
        return { ...createSessionsListResult(), sessions: [row] };
      }
      return method === "chat.send" ? steerAck.promise : Promise.resolve({});
    });
    const client = createTestGatewayClient(request);
    const { gateway, emitEvent } = createGatewayHarness(client);
    gateway.snapshot.sessionKey = row.key;
    const sessions = createTestSessionCapability(gateway);
    const context = createInitializationContext();
    const pane = createRenderTestChatPane();
    const state = pane.initialize({
      ...context,
      gateway: {
        ...context.gateway,
        ...gateway,
        get snapshot() {
          return { ...context.gateway.snapshot, ...gateway.snapshot };
        },
        subscribe(listener) {
          return gateway.subscribe((snapshot) =>
            listener({ ...context.gateway.snapshot, ...snapshot }),
          );
        },
      },
      sessions,
    });
    state.sessionKey = row.key;
    state.client = client;
    state.hello = sessionMutationGatewayHello();
    state.connected = true;
    state.chatModelCatalog = [
      { id: "primary", name: "Primary", provider: "example" },
      { id: "fallback", name: "Fallback", provider: "example" },
    ];
    await sessions.refresh({ agentId: "main", force: true });
    state.sessionsResult = sessions.state.result;
    state.sessionsResultAgentId = sessions.state.agentId;
    const stop = sessions.subscribe((snapshot) => {
      state.sessionsResult = snapshot.result;
      state.sessionsResultAgentId = snapshot.agentId;
    });
    const observation = sessions.observeRow({ key: row.key, agentId: "main" }, () => {}, {
      onEvent: (event, result) => handlePageGatewayEvent(state, event, undefined, result),
    });
    onTestFinished(() => {
      stop();
      observation.dispose();
      sessions.dispose();
      steerAck.resolve({});
    });
    const container = document.createElement("div");
    const draw = () => {
      const controls = renderControls(state, {
        agentDefaultModel: "example/primary",
        contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
      });
      render(controls.composerControls, container);
      const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]");
      expect(trigger?.dataset.chatSelectValue).toBe("example/primary");
      expect(trigger?.getAttribute("aria-busy")).toBe("false");
      expect(trigger?.querySelector(".btn__spinner")).toBeNull();
      return trigger?.textContent;
    };
    state.chatSending = true;
    state.chatSendingScopeKey = storedChatOutboxScopeKey({
      sessionKey: state.sessionKey,
      agentId: "main",
    });
    expect(draw()).toContain("Primary");
    adoptStartedChatRun(state, "current-run", 2);
    state.chatSending = false;
    expect(draw()).toContain("Primary");
    const observe = (
      runId: string,
      model: string | null,
      updatedAt: number,
      sessionKey = row.key,
    ) =>
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey,
          agentId: "main",
          runId,
          phase: "model",
          session: { ...row, key: sessionKey, updatedAt, activeModel: model },
        },
      });
    const expectFallbackExecution = () => {
      expect(draw()).toContain("Primary");
      expect(state.sessionsResult?.sessions[0]?.activeModel).toBe("fallback");
    };
    observe("current-run", "primary", 3);
    expect(draw()).toContain("Primary");
    observe("current-run", "fallback", 4);
    expectFallbackExecution();
    observe("previous-run", "primary", 1);
    expectFallbackExecution();
    observe("elsewhere-run", "primary", 5, "agent:main:elsewhere");
    expectFallbackExecution();
    observe("current-run", null, 6);
    expect(draw()).toContain("Primary");
    observe("current-run", "fallback", 7);
    expectFallbackExecution();
    adoptStartedChatRun(state, "replacement-run", 8);
    expect(draw()).toContain("Primary");
    observe("replacement-run", "primary", 9);
    expect(draw()).toContain("Primary");
    state.chatSending = true;
    state.chatQueue = [
      {
        id: "next-send",
        text: "Continue",
        createdAt: 10,
        sendState: "sending",
        sendRunId: "next-run",
      },
    ];
    observe("next-run", "fallback", 10);
    // A delayed event can carry the latest session projection but an older emitter ID.
    observe("replacement-run", "fallback", 10);
    expect(draw()).toContain("Primary");
    adoptStartedChatRun(state, "next-run", 11);
    state.chatSending = false;
    expectFallbackExecution();
    observe("next-run", "primary", 12);
    expect(draw()).toContain("Primary");
    vi.stubGlobal("sessionStorage", window.sessionStorage);
    onTestFinished(() => {
      sessionStorage.clear();
      vi.unstubAllGlobals();
    });
    state.chatQueue = [];
    const steer = {
      id: "held-steer",
      text: "Keep going",
      createdAt: 13,
      sendRunId: "steer-operation",
      sessionKey: state.sessionKey,
      agentId: "main",
    };
    expect(
      admitQueuedMessageForSession(
        state,
        captureChatOutboxAdmission(state, state.sessionKey, "main"),
        steer,
      ),
    ).toBe(true);
    const steering = steerQueuedChatMessage(state, steer.id);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          queueMode: "steer",
          idempotencyKey: steer.sendRunId,
        }),
        { timeoutMs: 30_000 },
      ),
    );
    expect(state.chatSending).toBe(true);
    observe("next-run", "fallback", 13);
    steerAck.resolve({ runId: steer.sendRunId, status: "started", messageSeq: 1 });
    await steering;
    await vi.waitFor(() => expect(state.chatSending).toBe(false));
    expect(state.chatRunId).toBe("next-run");
    expectFallbackExecution();
    reconcileChatRunLifecycle(state, { clearLocalRun: true, clearChatStream: true });
    expect(state.chatRunId).toBeNull();
  });

  it("does not show another session's pending model after switching sessions", () => {
    const previousSessionKey = "agent:main:previous";
    const selectedSession: GatewaySessionRow = {
      key: "agent:main:selected",
      kind: "direct",
      model: "primary",
      modelProvider: "example",
    };
    const pane = createRenderTestChatPane();
    const state = pane.initialize(createInitializationContext());
    Object.assign(state, {
      sessionKey: previousSessionKey,
      sessionsResult: { ...createSessionsListResult(), sessions: [selectedSession] },
      chatModelCatalog: [{ id: "primary", name: "Primary", provider: "example" }],
      chatModelSwitchPromises: {},
      connected: true,
      client: createTestGatewayClient(async () => ({})),
    });
    getChatSessionProjection(state, { sessionKey: previousSessionKey });
    state.chatRunId = "previous-session-run";
    state.chatStream = "Working";
    state.chatSending = true;
    state.chatSendingScopeKey = storedChatOutboxScopeKey({ sessionKey: previousSessionKey });
    setChatRunOwner(state, state.chatRunId);
    state.sessionKey = selectedSession.key;

    const controls = renderControls(state, {
      agentDefaultModel: "example/primary",
      contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
    });
    const container = document.createElement("div");
    render(controls.composerControls, container);

    const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]");
    expect(trigger?.textContent).toContain("Primary");
    expect(trigger?.textContent).not.toContain("Model pending");
    expect(trigger?.dataset.chatSelectValue).toBe("example/primary");
  });
});

function createControlsFixture(
  scope: string,
  sharingRole: GatewaySessionRow["sharingRole"] = "owner",
  globalTarget?: { sessionKey: string; rowAgentId: string },
) {
  const selectedSession = {
    key: globalTarget ? "global" : "agent:main:existing",
    ...(globalTarget ? { agentId: globalTarget.rowAgentId } : {}),
    kind: globalTarget ? "global" : "direct",
    sessionId: "existing-session",
    sharingRole,
    model: "gpt-test-a",
    modelProvider: "openai",
    thinkingLevel: "low",
    fastMode: false,
    thinkingLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
    contextWindow: "standard",
    contextWindowDefault: "standard",
    contextWindows: [
      { id: "standard", label: "Standard", contextWindow: 100000 },
      { id: "extended", label: "Extended", contextWindow: 200000 },
    ],
  } satisfies GatewaySessionRow;
  const sessionsResult = { ...createSessionsListResult(), sessions: [selectedSession] };
  const state = makeChatHost({
    sessionKey: globalTarget?.sessionKey ?? selectedSession.key,
    ...(globalTarget
      ? {
          assistantAgentId: "work",
          agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
          sessionsResultAgentId: globalTarget.rowAgentId,
        }
      : {}),
    sessionsResult,
    hello: sessionMutationGatewayHello([scope]),
    chatModelCatalog: [
      { id: "gpt-test-a", name: "Test model", provider: "openai", supportsFastMode: true },
      { id: "gpt-test-b", name: "Other model", provider: "openai", supportsFastMode: true },
    ],
    chatModelSwitchPromises: {},
    requestHandlers: {
      "sessions.patch": { ok: true, key: selectedSession.key, entry: selectedSession },
      "sessions.list": sessionsResult,
    },
  });
  const paneState = state as unknown as ChatPageHost;
  const visibleSession = selectedChatSessionRow(paneState);
  const access = readChatPaneMutationAccess(
    {
      client: state.client,
      phase: "connected",
      hello: state.hello,
    } as ApplicationGatewaySnapshot,
    state.sessionKey,
    visibleSession,
  );
  const controls = renderControls(paneState, {
    selectedSession: visibleSession,
    modelAccess: access.model,
    effortAccess: access.effort,
    contextWindowAccess: access.contextWindow,
    permissionAccess: access.permission,
    canSelectFull: scope === "operator.admin",
  });
  const container = document.createElement("div");
  render(controls.composerControls, container);
  return { state, selectedSession, access, controls, container };
}

describe("chat pane model-setting permissions", () => {
  it.each([
    { sessionKey: "agent:work:main", rowAgentId: "work", sharingRole: "owner", allowed: true },
    { sessionKey: "global", rowAgentId: "main", sharingRole: "owner", allowed: false },
  ] as const)(
    "dispatches settings only for the owned global target ($sessionKey, $rowAgentId, $sharingRole)",
    async ({ sessionKey, rowAgentId, sharingRole, allowed }) => {
      const { state, selectedSession, access } = createControlsFixture(
        "operator.sessions.write",
        sharingRole,
        { sessionKey, rowAgentId },
      );
      expect([access.model.allowed, access.effort.allowed]).toEqual([allowed, allowed]);

      const results = [
        await switchChatModel(state, "openai/gpt-test-b"),
        await switchChatSetting(state, { kind: "thinkingLevel", value: "high" }),
        await switchChatSetting(state, { kind: "fastMode", value: "on" }),
      ];
      expect(results).toEqual([allowed, allowed, allowed]);

      const target = {
        key: sessionKey,
        agentId: "work",
        expectedSessionId: selectedSession.sessionId,
      };
      expect(state.request.mock.calls.filter(([method]) => method === "sessions.patch")).toEqual(
        allowed
          ? [
              ["sessions.patch", { ...target, model: "openai/gpt-test-b" }],
              ["sessions.patch", { ...target, thinkingLevel: "high" }],
              ["sessions.patch", { ...target, fastMode: true }],
            ]
          : [],
      );
    },
  );

  it.each([
    { scope: "operator.read", sharingRole: "owner", allowed: false },
    { scope: "operator.sessions.write", sharingRole: "owner", allowed: true },
    { scope: "operator.sessions.write", sharingRole: "viewer", allowed: false },
    { scope: "operator.write", sharingRole: "viewer", allowed: true },
    { scope: "operator.admin", sharingRole: "viewer", allowed: true },
  ] as const)(
    "uses exact field permissions with $scope on a $sharingRole session",
    async ({ scope, sharingRole, allowed }) => {
      const { state, selectedSession, access, controls, container } = createControlsFixture(
        scope,
        sharingRole,
      );
      expect(access.unarchive.allowed).toBe(
        allowed && (scope === "operator.admin" || sharingRole === "owner"),
      );
      const readOnly = !allowed;
      expect(
        container.querySelector("[data-chat-model-select]")?.getAttribute("aria-disabled"),
      ).toBe(String(readOnly));
      expect(
        container.querySelector("[data-chat-thinking-select]")?.getAttribute("aria-disabled"),
      ).toBe(String(readOnly));
      const thinking = container.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
      const fast = container.querySelector<HTMLButtonElement>('[data-chat-speed-option="on"]')!;
      const context = container.querySelector<HTMLButtonElement>(
        "[data-chat-context-window-toggle]",
      )!;
      expect(thinking.disabled).toBe(readOnly);
      expect(fast.disabled).toBe(readOnly);
      expect(context.disabled).toBe(scope !== "operator.admin");
      context.click();
      if (!readOnly) {
        thinking.value = "1";
        thinking.dispatchEvent(new Event("change", { bubbles: true }));
        fast.click();
        await getPendingChatPickerPatch(state, state.sessionKey);
        expect(state.request).toHaveBeenCalledWith(
          "sessions.patch",
          expect.objectContaining({ key: selectedSession.key, fastMode: true }),
        );
        expect(state.request).toHaveBeenCalledWith(
          "sessions.patch",
          expect.objectContaining({ key: selectedSession.key, thinkingLevel: "high" }),
        );
      } else {
        fast.click();
        expect(state.request).not.toHaveBeenCalled();
      }
      const contextPatches = state.request.mock.calls.filter(
        ([method, params]) =>
          method === "sessions.patch" &&
          params &&
          typeof params === "object" &&
          "contextWindow" in params,
      );
      expect(contextPatches).toHaveLength(scope === "operator.admin" ? 1 : 0);
      container
        .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-test-b"]')!
        .click();
      await getPendingChatPickerPatch(state, state.sessionKey);
      if (allowed) {
        expect(state.request).toHaveBeenCalledWith(
          "sessions.patch",
          expect.objectContaining({
            key: selectedSession.key,
            model: "openai/gpt-test-b",
            expectedSessionId: selectedSession.sessionId,
          }),
        );
      }
      for (const permissionMode of ["read-only", "guarded", "workspace", null] as const) {
        await controls.permissionPicker.onSelect(permissionMode);
      }
      await controls.permissionPicker.onSelect("full");
      const permissionPatches = state.request.mock.calls.filter(
        ([method, params]) =>
          method === "sessions.patch" &&
          params &&
          typeof params === "object" &&
          "permissionMode" in params,
      );
      expect(permissionPatches).toHaveLength(allowed ? (scope === "operator.admin" ? 5 : 4) : 0);
    },
  );

  it.each([
    { change: "scope", queued: false },
    { change: "ownership", queued: false },
    { change: "missing-row", queued: false },
    { change: "session", queued: false },
    { change: "connection", queued: false },
    { change: "scope", queued: true },
    { change: "ownership", queued: true },
    { change: "session", queued: true },
  ] as const)(
    "rechecks picker authority after changing $change (queued: $queued)",
    async ({ change, queued }) => {
      const { state, selectedSession, controls, container } = createControlsFixture(
        queued ? "operator.sessions.write" : "operator.write",
      );
      const held = createDeferred<Awaited<ReturnType<typeof patchChatSessionSettings>>>();
      const operations: Promise<unknown>[] = [];
      if (queued) {
        state.request.mockImplementationOnce(async () => await held.promise);
        operations.push(
          patchChatSessionSettings(state, state.sessionKey, { thinkingLevel: "low" }),
          switchChatModel(state, "openai/gpt-test-b"),
          switchChatSetting(state, { kind: "thinkingLevel", value: "high" }),
          switchChatSetting(state, { kind: "fastMode", value: "on" }),
          Promise.resolve(controls.permissionPicker.onSelect("guarded")),
        );
      }
      if (change === "scope") {
        state.hello = sessionMutationGatewayHello(["operator.sessions.read"]);
      } else if (change === "ownership") {
        state.hello = sessionMutationGatewayHello(["operator.sessions.write"]);
        selectedSession.sharingRole = "viewer";
      } else if (change === "missing-row") {
        state.hello = sessionMutationGatewayHello(["operator.sessions.write"]);
        state.sessionsResult = { ...createSessionsListResult(), sessions: [] };
      } else if (change === "session") {
        selectedSession.sessionId = "replacement-session";
      } else {
        state.connectionEpoch = (state.connectionEpoch ?? 0) + 1;
      }
      if (queued) {
        held.resolve({ ok: true, path: "", key: selectedSession.key, entry: selectedSession });
        await Promise.all(operations);
        expect(
          state.request.mock.calls.filter(([method]) => method === "sessions.patch"),
        ).toHaveLength(1);
        return;
      }
      container
        .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-test-b"]')!
        .click();
      const thinking = container.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
      thinking.value = "1";
      thinking.dispatchEvent(new Event("change", { bubbles: true }));
      container.querySelector<HTMLButtonElement>('[data-chat-speed-option="on"]')!.click();
      await controls.permissionPicker.onSelect("guarded");
      await getPendingChatPickerPatch(state, state.sessionKey);
      expect(state.request).not.toHaveBeenCalled();
    },
  );
});
