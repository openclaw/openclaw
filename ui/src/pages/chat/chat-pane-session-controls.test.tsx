/* @vitest-environment jsdom */

import { createComponent, createMemo, Show } from "solid-js";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  ChatAccountSelection,
  UsersListModelAccountsResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
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
import { installModelPickerLayout } from "../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createInitializationContext } from "./chat-application-context.test-support.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { admitQueuedMessageForSession } from "./chat-outbox-admission.test-support.ts";
import { ChatPaneModelControl } from "./chat-pane-model-control.tsx";
import { renderControls } from "./chat-pane-session-controls.test-support.ts";
import { createRenderTestChatPane } from "./chat-pane.test-support.ts";
import { steerQueuedChatMessage } from "./chat-send-actions.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import { handlePageGatewayEvent } from "./chat-state-events.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
import { ChatModelAccountSectionView } from "./components/chat-model-account-control.tsx";
import { expandModelProviders } from "./components/chat-model-picker.test-support.tsx";
import { ChatPermissionPicker } from "./components/chat-permission-picker.tsx";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

beforeEach(installModelPickerLayout);

describe("chat account selection", () => {
  function mountAccountControl(
    request: GatewayRequestHandler,
    selection: ChatAccountSelection | null,
  ) {
    const container = document.createElement("div");
    let current = true;
    const state = projectChatFields<Pick<ChatPageHost, "client" | "chatAccountSelection">>({
      client: createTestGatewayClient(request),
      chatAccountSelection: selection,
    });
    const onSelect = vi.fn(async () => true);
    const onManage = vi.fn();
    mountSolid(
      () => {
        const section = createMemo(() =>
          renderChatModelAccountControl({
            owner: state,
            client: state.client,
            selection: state.chatAccountSelection,
            model: "openai/gpt-5.5",
            disabled: false,
            ownsSelection: () => current,
            onSelect,
            onManage,
          }),
        );
        return (
          <Show when={section()}>
            {(activeSection) => <ChatModelAccountSectionView {...activeSection().viewProps(0)} />}
          </Show>
        );
      },
      { container },
    );
    flush();
    return {
      container,
      state,
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
    flush();
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
    flush();
    expect(view.container.textContent).not.toContain("Old connection account");
    view.select("account:openai:old");
    expect(view.onSelect).not.toHaveBeenCalled();
  });
});

describe("chat pane composer controls", () => {
  it("renders the selected Gateway model while keeping its model picker locked", async () => {
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
    const { container } = mountSolid(() =>
      createComponent(ChatPaneModelControl, controls.composerControls),
    );
    flush();

    const trigger = container.querySelector<HTMLElement>("[data-chat-model-select]");
    expect(trigger?.textContent).toContain("GPT-5.6 Sol");
    expect(trigger?.getAttribute("aria-label")).toBe("Chat model: GPT-5.6 Sol");
    expect(trigger?.dataset.chatModelLocked).toBe("true");
    expect(state.request).not.toHaveBeenCalled();
    trigger?.click();
    await waitForSolid(() =>
      expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull(),
    );
    expect(container.querySelector(".chat-controls__locked-model-value")?.textContent).toBe(
      "GPT-5.6 Sol",
    );
    expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(0);
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
    async ({ cached, connected = true, error, message }) => {
      const container = document.body.appendChild(document.createElement("div"));
      onTestFinished(() => container.remove());
      const state = makeChatHost({
        connected,
        requestHandlers: {},
        sessionsResult: createSessionsListResult({
          model: "cached-model",
          modelProvider: "openai",
        }),
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
      controls.composerControls.model.modelPickerOpen = true;
      mountSolid(() => createComponent(ChatPaneModelControl, controls.composerControls), {
        container,
      });
      await waitForSolid(() =>
        expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull(),
      );

      expandModelProviders(container);

      expect(container.querySelectorAll(".chat-composer-model-control")).toHaveLength(1);
      expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
      expect(container.querySelector('[data-chat-permission-select="true"]')).toBeNull();
      const catalogMessage = container.querySelector(".chat-controls__model-catalog-state");
      expect(catalogMessage?.textContent).toContain(message);
      expect(
        container.querySelector('[data-chat-model-select="true"]')?.getAttribute("aria-disabled"),
      ).toBe(String(!connected));
      expect(container.querySelectorAll("[data-chat-model-option]")).toHaveLength(cached ? 1 : 0);
      const permissionContainer = document.createElement("div");
      mountSolid(() => createComponent(ChatPermissionPicker, controls.permissionPicker), {
        container: permissionContainer,
      });
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
    document.body.append(container);
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
    const view = mountSolid(
      () => createComponent(ChatPermissionPicker, controls.permissionPicker),
      {
        container,
      },
    );
    onTestFinished(() => {
      view.unmount();
      container.remove();
    });
    flush();
    const trigger = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
    trigger.click();
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));

    const heading = container.querySelector<HTMLElement>(".chat-controls__permission-heading");
    expect(heading?.textContent?.trim()).toBe("Execution permissions");
    expect(heading?.closest('[role="menuitem"]')).toBeNull();
    const docsLink = container.querySelector<HTMLElement>("a.chat-controls__permission-learn-more");
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.getAttribute("href")).toBe(
      "https://docs.openclaw.ai/gateway/permission-modes",
    );
    expect(docsLink?.getAttribute("target")).toBe("_blank");
    const rel = docsLink?.getAttribute("rel")?.split(/\s+/).toSorted();
    expect(rel).toEqual(["noopener", "noreferrer"]);

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

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    await vi.waitFor(() =>
      expect(getPendingChatPickerPatch(state, state.sessionKey)).toBeUndefined(),
    );
    expect(patch).toHaveBeenCalledWith(
      selectedSession.key,
      { permissionMode: "guarded" },
      expect.objectContaining({ agentId: undefined, expectedSessionId: "permission-test-session" }),
    );

    trigger.click();
    await waitForSolid(() => expect(menu.matches(":popover-open")).toBe(true));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
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
    projectChatFields(state, ["sessionsResult"]);
    const patch = vi.spyOn(state.sessions, "patch").mockImplementation(() => patchResult.promise);
    const controls = renderControls(state);
    const { container } = mountSolid(() => {
      const current = createMemo(() => renderControls(state).permissionPicker);
      return <ChatPermissionPicker {...current()} />;
    });

    expect(controls.permissionPicker.disabled).toBe(false);
    const selection = controls.permissionPicker.onSelect("workspace");
    flush();
    const trigger = container.querySelector<HTMLButtonElement>("[data-chat-permission-select]")!;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-label")).toBe("Execution permissions: Workspace");
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
    flush();

    expect(state.chatError).toBeNull();
    expect(trigger.disabled).toBe(false);
    expect(trigger.getAttribute("aria-label")).toBe("Execution permissions: Workspace");
  });

  it.each([
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
    let view: ReturnType<typeof mountSolid> | undefined;
    const draw = () => {
      view?.unmount();
      const controls = renderControls(state, {
        agentDefaultModel: "example/primary",
        contextWindowAccess: { allowed: true, requiredScope: "operator.write" },
      });
      view = mountSolid(() => createComponent(ChatPaneModelControl, controls.composerControls), {
        container,
      });
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
        {
          timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS,
          signal: expect.any(AbortSignal),
          retainSentResultOnAbort: true,
        },
      ),
    );
    expect(state.chatSending).toBe(true);
    observe("next-run", "fallback", 13);
    steerAck.resolve({ runId: steer.sendRunId, status: "started", messageSeq: 1 });
    await steering;
    await vi.waitFor(() => expect(state.chatSending).toBe(false));
    expect(state.chatRunId).toBe("next-run");
    expectFallbackExecution();
    reconcileChatRunLifecycle(state, { clearLocalRun: true });
    expect(state.chatRunId).toBeNull();
  });
});
