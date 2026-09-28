/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { switchChatFastMode, switchChatModel, switchChatThinkingLevel } from "./chat-session.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";

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
  const controls = renderChatPaneComposerControls({
    state: paneState,
    selectedSession: visibleSession,
    agentDefaultModel: undefined,
    modelAccess: access.model,
    effortAccess: access.effort,
    contextWindowAccess: access.contextWindow,
    permissionAccess: access.permission,
    canSelectFull: scope === "operator.admin",
    onModelSetup: vi.fn(),
  });
  const container = document.createElement("div");
  render(controls.composerControls, container);
  return { state, selectedSession, access, controls, container };
}

describe("chat pane model-setting permissions", () => {
  it.each([
    { sessionKey: "agent:work:main", rowAgentId: "work", sharingRole: "owner", allowed: true },
    { sessionKey: "agent:work:main", rowAgentId: "work", sharingRole: "viewer", allowed: false },
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
        await switchChatThinkingLevel(state, "high"),
        await switchChatFastMode(state, "on"),
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
    { scope: "operator.sessions.write", sharingRole: "member", allowed: false },
    { scope: "operator.sessions.write", sharingRole: "viewer", allowed: false },
    { scope: "operator.write", sharingRole: "viewer", allowed: true },
    { scope: "operator.admin", sharingRole: "viewer", allowed: true },
  ] as const)(
    "uses exact field permissions with $scope on a $sharingRole session",
    async ({ scope, sharingRole, allowed }) => {
      const { state, selectedSession, controls, container } = createControlsFixture(
        scope,
        sharingRole,
      );
      const readOnly = !allowed;
      expect(
        container.querySelector("[data-chat-model-select]")?.getAttribute("aria-disabled"),
      ).toBe(String(readOnly));
      expect(
        container.querySelector("[data-chat-thinking-select]")?.getAttribute("aria-disabled"),
      ).toBe(String(readOnly));
      const thinking = container.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
      const fast = container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")!;
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

  it.each(["scope", "ownership", "missing-row", "session", "connection"] as const)(
    "rejects retained picker actions after changing %s",
    async (change) => {
      const { state, selectedSession, controls, container } =
        createControlsFixture("operator.write");
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
      container
        .querySelector<HTMLButtonElement>('[data-chat-model-option="openai/gpt-test-b"]')!
        .click();
      const thinking = container.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
      thinking.value = "1";
      thinking.dispatchEvent(new Event("change", { bubbles: true }));
      container.querySelector<HTMLButtonElement>("[data-chat-speed-toggle]")!.click();
      await controls.permissionPicker.onSelect("guarded");
      await getPendingChatPickerPatch(state, state.sessionKey);
      expect(state.request).not.toHaveBeenCalled();
    },
  );

  it.each(["scope", "ownership", "session"] as const)(
    "rechecks queued settings after changing %s",
    async (change) => {
      const { state, selectedSession, controls } = createControlsFixture("operator.sessions.write");
      const held = createDeferred<Awaited<ReturnType<typeof patchChatSessionSettings>>>();
      state.request.mockImplementationOnce(async () => await held.promise);
      const first = patchChatSessionSettings(state, state.sessionKey, { thinkingLevel: "low" });
      const model = switchChatModel(state, "openai/gpt-test-b");
      const effort = switchChatThinkingLevel(state, "high");
      const fast = switchChatFastMode(state, "on");
      const permission = controls.permissionPicker.onSelect("guarded");
      if (change === "scope") {
        state.hello = sessionMutationGatewayHello(["operator.sessions.read"]);
      } else if (change === "ownership") {
        selectedSession.sharingRole = "viewer";
      } else {
        selectedSession.sessionId = "replacement-session";
      }
      held.resolve({ ok: true, path: "", key: selectedSession.key, entry: selectedSession });
      await Promise.all([first, model, effort, fast, permission]);
      expect(
        state.request.mock.calls.filter(([method]) => method === "sessions.patch"),
      ).toHaveLength(1);
    },
  );
});
