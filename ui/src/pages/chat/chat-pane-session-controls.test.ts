/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  ChatAccountSelection,
  UsersListModelAccountsResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { SessionRefreshOutcome } from "../../lib/sessions/session-capability.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import { getPendingChatPickerPatch } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
import { renderChatPermissionPicker } from "./components/chat-permission-picker.ts";

function iconMarkup(icon: unknown): string | undefined {
  const container = document.createElement("div");
  render(icon as never, container);
  return container.querySelector("svg")?.innerHTML;
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

  it("does not invent an account label without authoritative chat metadata", () => {
    const request = vi.fn();
    const view = mountAccountControl(request, null);
    expect(view.container.querySelector("wa-dropdown")).toBeNull();
    expect(request).not.toHaveBeenCalled();
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
    const controls = renderChatPaneComposerControls({
      state: state as unknown as ChatPageHost,
      selectedSession: state.sessionsResult?.sessions[0],
      agentDefaultModel: "openai/gpt-5.6-luna",
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
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
      connected: true,
      error: "metadata unavailable",
      message: "Some models could not be refreshed. Open Models to try again.",
    },
    {
      label: "failed without a snapshot",
      cached: false,
      connected: true,
      error: "metadata unavailable",
      message: "Models unavailable",
    },
  ])(
    "renders separate footer inputs with a $label catalog",
    ({ cached, connected, error, message }) => {
      const container = document.createElement("div");
      const state = {
        chatRunId: null,
        connected,
        client: {},
        chatLoading: false,
        chatModelCatalog: cached
          ? [{ id: "cached-model", name: "Cached Model", provider: "openai", available: false }]
          : [],
        chatModelCatalogError: error,
        sessions: { state: { modelOverrides: {} }, think: () => undefined, patch: vi.fn() },
        chatModelSwitchPromises: {},
        sessionKey: "main",
        chatModelsLoading: false,
        chatSending: false,
        sessionsResult: null,
        chatStream: null,
      } as unknown as ChatPageHost;
      const onModelSetup = vi.fn();

      const controls = renderChatPaneComposerControls({
        state,
        selectedSession: undefined,
        agentDefaultModel: undefined,
        agentDefaultPermissionMode: "guarded",
        modelAccess: { allowed: true, requiredScope: "operator.write" },
        effortAccess: { allowed: true, requiredScope: "operator.write" },
        contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
        permissionAccess: { allowed: true, requiredScope: "operator.write" },
        canSelectFull: true,
        onModelSetup,
      });
      render(controls.composerControls, container);

      expect(Array.from(container.children).map((node) => node.className)).toEqual([
        "chat-composer-model-control",
      ]);
      expect(container.querySelector('[data-chat-provider-usage="true"]')).toBeNull();
      expect(container.querySelector('[data-chat-permission-select="true"]')).toBeNull();
      const catalogMessage = container.querySelector(".chat-controls__model-catalog-state");
      if (message) {
        expect(catalogMessage?.textContent).toContain(message);
      } else {
        expect(catalogMessage).toBeNull();
      }
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
        permissionContainer.querySelector('[data-chat-permission-select="true"]')?.textContent,
      ).toContain("Default (Guarded)");
      container.querySelector<HTMLButtonElement>('[data-chat-model-setup="true"]')?.click();
      expect(onModelSetup).toHaveBeenCalledTimes(error ? 0 : 1);
    },
  );

  it("renders a distinct active icon for every permission mode", () => {
    const activeIcons = new Set<string>();
    for (const mode of [undefined, "read-only", "guarded", "workspace", "full"] as const) {
      const container = document.createElement("div");
      render(
        renderChatPermissionPicker({
          canSelectFull: true,
          mode,
          onSelect: () => undefined,
        }),
        container,
      );
      const icon = container.querySelector(".chat-controls__permission-icon svg");
      expect(icon).not.toBeNull();
      activeIcons.add(icon?.outerHTML ?? "");
    }
    expect(activeIcons.size).toBe(5);
  });

  it.each([
    [undefined, "Default"],
    ["read-only", "Default (Read Only)"],
    ["guarded", "Default (Guarded)"],
    ["workspace", "Default (Workspace)"],
    ["full", "Default (Full Access)"],
  ] as const)(
    "renders inherited permissions for %s without selecting a mode",
    (defaultMode, label) => {
      const container = document.createElement("div");
      const onSelect = vi.fn();
      render(
        renderChatPermissionPicker({ canSelectFull: false, defaultMode, onSelect }),
        container,
      );
      const trigger = container.querySelector('[data-chat-permission-select="true"]');
      const option = container.querySelector('[data-chat-permission-option="default"]');
      const fullAccess = defaultMode === "full";
      expect(trigger?.textContent?.trim()).toBe(label);
      expect(trigger?.getAttribute("aria-label")).toBe(`Execution permissions: ${label}`);
      expect(trigger?.getAttribute("data-chat-select-value")).toBe("");
      expect(trigger?.classList.contains("chat-controls__permission-trigger--full")).toBe(
        fullAccess,
      );
      expect(
        trigger
          ?.querySelector(".chat-controls__inline-select-label")
          ?.classList.contains("chat-controls__permission-label--full"),
      ).toBe(fullAccess);
      expect(
        option?.querySelector(".chat-controls__permission-option-title")?.textContent?.trim(),
      ).toBe(label);
      expect(option?.getAttribute("aria-checked")).toBe("true");
      expect(option?.textContent).toContain("Follow the agent's configured execution permissions.");
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("links the permission picker to the permission modes guide", () => {
    const container = document.createElement("div");
    render(
      renderChatPermissionPicker({
        canSelectFull: true,
        mode: "workspace",
        onSelect: () => undefined,
      }),
      container,
    );

    const docsLink = container.querySelector<HTMLAnchorElement>(
      ".chat-controls__permission-learn-more",
    );
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.href).toBe("https://docs.openclaw.ai/gateway/permission-modes");
    expect(docsLink?.target).toBe("_blank");
    expect(docsLink?.rel.split(/\s+/).toSorted()).toEqual(["noopener", "noreferrer"]);
  });

  it("patches a rootless session, clears to default, and locks full access", async () => {
    const container = document.createElement("div");
    const patch = vi.fn(async () => ({}));
    const state = {
      chatRunId: null,
      connected: true,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: { state: { modelOverrides: {} }, think: () => undefined, patch },
      chatModelSwitchPromises: {},
      sessionKey: "agent:main:permission-test",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
    } as unknown as ChatPageHost;

    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: {
        key: "agent:main:permission-test",
        kind: "direct",
        permissionMode: "full",
        sessionId: "permission-test-session",
      },
      agentDefaultModel: undefined,
      agentDefaultPermissionMode: "guarded",
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: false,
      onModelSetup: vi.fn(),
    });
    render(renderChatPermissionPicker(controls.permissionPicker), container);

    const dropdown = container.querySelector<HTMLElement>(".chat-controls__permission-picker");
    dropdown?.setAttribute("open", "");
    const full = container.querySelector<HTMLElement>('[data-chat-permission-option="full"]');
    const defaultOption = container.querySelector<HTMLElement>(
      '[data-chat-permission-option="default"]',
    );
    const permissionIcons = {
      default: icons.shieldCheck,
      "read-only": icons.shieldEllipsis,
      guarded: icons.shieldLock,
      workspace: icons.shieldCog,
      full: icons.shieldAlert,
    };
    for (const [mode, icon] of Object.entries(permissionIcons)) {
      const renderedIcon = container.querySelector<SVGElement>(
        `[data-chat-permission-option="${mode}"] .chat-controls__permission-option-icon svg`,
      );
      expect(renderedIcon?.innerHTML).toBe(iconMarkup(icon));
      expect(renderedIcon?.getAttribute("fill")).toBe("none");
      expect(renderedIcon?.getAttribute("stroke-width")).toBe("2");
    }
    expect(defaultOption?.textContent).toContain(
      "Follow the agent's configured execution permissions.",
    );
    expect(defaultOption?.textContent).toContain("Default (Guarded)");
    expect(
      container.querySelector('[data-chat-permission-select="true"]')?.textContent?.trim(),
    ).toBe("Full Access");
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
      "agent:main:permission-test",
      { permissionMode: "guarded" },
      expect.objectContaining({ agentId: undefined, expectedSessionId: "permission-test-session" }),
    );

    dropdown?.setAttribute("open", "");
    dropdown?.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    await Promise.resolve();
    expect(patch).toHaveBeenLastCalledWith(
      "agent:main:permission-test",
      { permissionMode: null },
      expect.objectContaining({ agentId: undefined, expectedSessionId: "permission-test-session" }),
    );
  });

  it("patches an identity-less session while its first identity materializes", async () => {
    const patchResult = createDeferred<Record<string, never>>();
    const patch = vi.fn(() => patchResult.promise);
    const key = "agent:main:first-materialization";
    const selectedSession = { key, kind: "direct" as const, permissionMode: "guarded" as const };
    const state = {
      connected: true,
      connectionEpoch: 1,
      client: {},
      sessions: { state: { modelOverrides: {} }, think: () => undefined, patch },
      sessionKey: key,
      sessionsResult: { defaults: {}, sessions: [selectedSession] },
      chatModelCatalog: [],
      chatModelSwitchPromises: {},
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    });

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
    patchResult.resolve({});
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
    {
      label: "unavailable update after switching sessions",
      result: "null",
      invalidate: (state: ChatPageHost) => {
        state.sessionKey = "agent:main:other-session";
      },
    },
  ] as const)("suppresses alerts for a $label", async (lifecycleCase) => {
    const { invalidate, result } = lifecycleCase;
    const pending = createDeferred<Record<string, never> | null>();
    const state = {
      assistantAgentId: "main",
      chatRunId: "remote-worker-run",
      chatError: null,
      connected: true,
      connectionEpoch: 1,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: {
        state: { modelOverrides: {} },
        think: () => undefined,
        patch: vi.fn(() => pending.promise),
      },
      chatModelSwitchPromises: {},
      sessionKey:
        "initialSessionKey" in lifecycleCase
          ? lifecycleCase.initialSessionKey
          : "agent:main:remote-worker",
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const controls = renderChatPaneComposerControls({
      state,
      selectedSession: {
        key: state.sessionKey,
        kind: "direct",
        hasActiveRun: true,
        sessionId: "lifecycle-session",
      },
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    });

    const selection = controls.permissionPicker.onSelect("full");
    invalidate(state);
    if (result === "failure") {
      pending.reject(new Error("original remote worker disconnected"));
    } else {
      pending.resolve(result === "null" ? null : {});
    }
    await selection;

    expect(state.chatError).toBeNull();
  });

  it.each([
    {
      source: "primary list",
      persistedMode: "full",
      foregroundAgent: "main",
      recovery: "immediate",
    },
    {
      source: "observed row with another agent selected",
      persistedMode: "guarded",
      foregroundAgent: "research",
      recovery: "immediate",
    },
    {
      source: "later scoped recovery",
      persistedMode: "guarded",
      foregroundAgent: "research",
      recovery: "affected",
    },
    {
      source: "later identical observed row",
      persistedMode: "workspace",
      foregroundAgent: "research",
      recovery: "identical",
    },
    {
      source: "unrelated foreground refresh",
      persistedMode: "guarded",
      foregroundAgent: "research",
      recovery: "unrelated",
    },
  ] as const)(
    "reconciles the permission picker after application fails ($source)",
    async ({ persistedMode, foregroundAgent, recovery }) => {
      const pending = createDeferred<Record<string, never>>();
      let permissionMode: GatewaySessionRow["permissionMode"] = "workspace";
      let recoveryUnavailable = false;
      const selectedSession: GatewaySessionRow = {
        key: "agent:main:remote-worker",
        kind: "direct",
        hasActiveRun: true,
        permissionMode,
        sessionId: "remote-worker-session",
        ...(recovery === "identical" ? { updatedAt: 1 } : {}),
      };
      const otherSession: GatewaySessionRow = { key: "agent:research:other", kind: "direct" };
      const host = makeChatHost({
        sessionKey: selectedSession.key,
        assistantAgentId: "main",
        chatModelSwitchPromises: {},
        requestHandlers: {
          "sessions.patch": () => pending.promise,
          "sessions.list": (params: { agentId?: string }) => {
            if (params.agentId === "main" && recoveryUnavailable) {
              throw new Error("Permission read unavailable");
            }
            return {
              ...createSessionsListResult(),
              sessions:
                params.agentId === "main"
                  ? [{ ...selectedSession, permissionMode }]
                  : [otherSession],
            };
          },
        },
      });
      const state = host as unknown as ChatPageHost;
      const observation = host.sessions.observeRow(
        { key: selectedSession.key, agentId: "main" },
        () => undefined,
      );
      const controlParams = {
        state,
        get selectedSession() {
          return observation.row ?? undefined;
        },
        agentDefaultModel: undefined,
        modelAccess: { allowed: true, requiredScope: "operator.write" } as const,
        effortAccess: { allowed: true, requiredScope: "operator.write" } as const,
        contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
        permissionAccess: { allowed: true, requiredScope: "operator.write" } as const,
        canSelectFull: true,
        onModelSetup: vi.fn(),
      };
      let selection: Promise<unknown> = Promise.resolve();
      try {
        await host.sessions.refresh({ agentId: "main", force: true });
        const controls = renderChatPaneComposerControls(controlParams);
        selection = Promise.resolve(controls.permissionPicker.onSelect("full"));
        await vi.waitFor(() =>
          expect(host.request).toHaveBeenCalledWith(
            "sessions.patch",
            expect.objectContaining({
              key: selectedSession.key,
              permissionMode: "full",
              expectedSessionId: selectedSession.sessionId,
            }),
          ),
        );
        const container = document.createElement("div");
        const draw = () =>
          render(
            renderChatPermissionPicker(
              renderChatPaneComposerControls(controlParams).permissionPicker,
            ),
            container,
          );
        draw();
        const trigger = container.querySelector<HTMLButtonElement>(
          "[data-chat-permission-select]",
        )!;
        expect(trigger.textContent).toContain(t("chat.permissionControls.modes.full.label"));
        expect(trigger.textContent).not.toContain("Applying permissions");
        expect(trigger.disabled).toBe(true);
        void controls.permissionPicker.onSelect("guarded");
        expect(
          host.request.mock.calls.filter(([method]) => method === "sessions.patch"),
        ).toHaveLength(1);
        expect(
          host.request.mock.calls.find(([method]) => method === "sessions.patch")?.[1],
        ).not.toHaveProperty("agentId");
        if (recovery === "identical") {
          expect(observation.captureReconcile()({ ...selectedSession })).toMatchObject({
            status: "current",
            row: { permissionMode: "workspace", updatedAt: 1 },
          });
        }
        state.assistantAgentId = foregroundAgent;
        await host.sessions.refresh({ agentId: foregroundAgent, force: true });
        const revision = host.sessions.canonicalListRevision;
        permissionMode = persistedMode;
        recoveryUnavailable = recovery !== "immediate";
        pending.reject(new Error("saved mode could not be applied to the active run"));
        await selection;
        expect(state.chatError).toContain("Failed to update permissions");
        if (recovery !== "immediate") {
          draw();
          expect(trigger.textContent).toContain(t("chat.permissionControls.modes.full.label"));
          expect(trigger.disabled).toBe(false);
          recoveryUnavailable = false;
          if (recovery === "affected") {
            await host.sessions.reconcileMutation("main");
          } else if (recovery === "identical") {
            expect(observation.captureReconcile()({ ...selectedSession })).toMatchObject({
              status: "current",
              row: { permissionMode: persistedMode, updatedAt: 1 },
            });
          } else {
            await host.sessions.refresh({ agentId: "research", force: true });
          }
        }
        expect(host.sessions.state.agentId).toBe(foregroundAgent);
        expect(host.sessions.state.result?.sessions.map((row) => row.key)).toEqual([
          foregroundAgent === "main" ? selectedSession.key : otherSession.key,
        ]);
        draw();
        expect(trigger.textContent).toContain(
          t(
            `chat.permissionControls.modes.${recovery === "unrelated" ? "full" : persistedMode}.label`,
          ),
        );
        expect(trigger.disabled).toBe(false);
        expect(host.sessions.canonicalListRevision).toBe(
          revision + (foregroundAgent === "main" || recovery === "unrelated" ? 1 : 0),
        );
      } finally {
        pending.resolve({});
        await selection;
        observation.dispose();
        host.sessions.dispose();
      }
    },
  );

  it("binds permission choices to the observed session incarnation", async () => {
    const originalSessionId = "session-before-replacement";
    const replacementSessionId = "session-after-replacement";
    let persistedMode = "workspace";
    const patch = vi.fn(
      async (
        _key: string,
        params: {
          permissionMode?: "workspace" | "read-only" | "guarded" | "full" | null;
        },
        options?: { expectedSessionId?: string },
      ) => {
        if (options?.expectedSessionId !== originalSessionId) {
          persistedMode = params.permissionMode ?? "default";
          return {};
        }
        return null;
      },
    );
    const selectedSession = {
      key: "agent:main:recreated",
      kind: "direct" as const,
      permissionMode: "workspace" as const,
      sessionId: originalSessionId,
    };
    const state = {
      chatRunId: null,
      chatError: null,
      connected: true,
      connectionEpoch: 1,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: {
        state: { modelOverrides: {} },
        think: () => undefined,
        patch,
        capturePermissionObservation: () => () => true,
        reconcileMutation: vi.fn(async () => {
          selectedSession.sessionId = replacementSessionId;
          return { status: "refreshed" as const };
        }),
      },
      chatModelSwitchPromises: {},
      sessionKey: selectedSession.key,
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;

    await renderChatPaneComposerControls({
      state,
      selectedSession,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" },
      effortAccess: { allowed: true, requiredScope: "operator.write" },
      contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
      permissionAccess: { allowed: true, requiredScope: "operator.write" },
      canSelectFull: true,
      onModelSetup: vi.fn(),
    }).permissionPicker.onSelect("full");

    expect(patch).toHaveBeenCalledWith(
      selectedSession.key,
      { permissionMode: "full" },
      expect.objectContaining({ expectedSessionId: originalSessionId }),
    );
    expect(selectedSession.sessionId).toBe(replacementSessionId);
    expect(persistedMode).toBe("workspace");
    expect(state.chatError).toContain("Failed to update permissions");
  });

  it("does not publish an older permission error over a replacement session success", async () => {
    const firstPatch = createDeferred<Record<string, never>>();
    const firstRefresh = createDeferred<SessionRefreshOutcome>();
    const selectedSession = {
      key: "agent:main:replaced-during-permission-change",
      kind: "direct" as const,
      permissionMode: "workspace" as "workspace" | "read-only" | "guarded" | "full",
      sessionId: "permission-session-before-replacement",
    };
    const patch = vi.fn(
      async (
        _key: string,
        params: {
          permissionMode?: "workspace" | "read-only" | "guarded" | "full" | null;
        },
        options?: { expectedSessionId?: string; waitFor?: Promise<boolean> },
      ) => {
        if (options?.expectedSessionId === "permission-session-before-replacement") {
          return await firstPatch.promise;
        }
        await options?.waitFor;
        selectedSession.permissionMode = params.permissionMode ?? "workspace";
        return {};
      },
    );
    const state = {
      chatRunId: null,
      chatError: null,
      lastError: null,
      connected: true,
      connectionEpoch: 1,
      client: {},
      chatLoading: false,
      chatModelCatalog: [],
      sessions: {
        state: { modelOverrides: {} },
        think: () => undefined,
        patch,
        capturePermissionObservation: () => () => true,
        reconcileMutation: vi.fn(async () => await firstRefresh.promise),
      },
      chatModelSwitchPromises: {},
      sessionKey: selectedSession.key,
      chatModelsLoading: false,
      chatSending: false,
      sessionsResult: null,
      chatStream: null,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const params = {
      state,
      selectedSession,
      agentDefaultModel: undefined,
      modelAccess: { allowed: true, requiredScope: "operator.write" } as const,
      effortAccess: { allowed: true, requiredScope: "operator.write" } as const,
      contextWindowAccess: { allowed: true, requiredScope: "operator.admin" } as const,
      permissionAccess: { allowed: true, requiredScope: "operator.write" } as const,
      canSelectFull: true,
      onModelSetup: vi.fn(),
    };

    const olderSelection = renderChatPaneComposerControls(params).permissionPicker.onSelect("full");
    await vi.waitFor(() => expect(patch).toHaveBeenCalledOnce());
    selectedSession.sessionId = "permission-session-after-replacement";
    selectedSession.permissionMode = "read-only";
    firstPatch.reject(new Error("older permission change failed"));
    await vi.waitFor(() => expect(state.sessions.reconcileMutation).toHaveBeenCalledOnce());
    const newerSelection =
      renderChatPaneComposerControls(params).permissionPicker.onSelect("guarded");
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));

    await newerSelection;
    expect(selectedSession.permissionMode).toBe("guarded");
    expect(state.chatError).toBeNull();
    firstRefresh.resolve({ status: "refreshed" });
    await olderSelection;
    expect(state.sessions.reconcileMutation).toHaveBeenCalledOnce();
    expect(state.chatError).toBeNull();
    expect(state.lastError).toBeNull();
  });
});
