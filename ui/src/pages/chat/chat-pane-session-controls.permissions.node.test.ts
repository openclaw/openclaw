/* @vitest-environment jsdom */

import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { Model } from "../../../../src/llm/types.js";
import { buildProviderStreamFamilyHooks } from "../../../../src/plugin-sdk/provider-stream.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { renderPaneLegacyContent } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  readChatPaneMutationAccess,
  renderChatPaneComposerControls,
} from "./chat-pane-session-controls.ts";
import { createInitializationContext, createRenderTestChatPane } from "./chat-pane.test-support.ts";
import { switchChatModel, switchChatSetting } from "./chat-session.ts";
import { getPendingChatPickerPatch, patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { setChatRunOwner } from "./history-merge.ts";

// mock-isolation: Vite's jsdom URLs are not file URLs; load the unchanged SQL as a raw asset.
vi.mock("../../../../src/state/openclaw-agent-schema.js", async () => ({
  OPENCLAW_AGENT_SCHEMA_SQL: (await import("../../../../src/state/openclaw-agent-schema.sql?raw"))
    .default,
}));

// mock-isolation: The native loader requires a file URL; Vite supplies the same SQL as a raw asset.
vi.mock("../../../../src/state/openclaw-state-schema.js", async () => ({
  OPENCLAW_STATE_SCHEMA_SQL: (await import("../../../../src/state/openclaw-state-schema.sql?raw"))
    .default,
}));

const requests = vi.hoisted(() => [] as unknown[]);
vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: (request: unknown) => {
        requests.push(request);
        throw new Error("captured before sending");
      },
    };
  },
}));

async function captureSpeedRequest(cfg: OpenClawConfig, sessionEntry: GatewaySessionRow) {
  const model: Model<"openai-responses"> = {
    id: "gpt-test-a",
    name: "Speed fixture",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const wrap = buildProviderStreamFamilyHooks("openai-responses-defaults").wrapStreamFn;
  if (!wrap) {
    throw new Error("Expected OpenAI request wrapper");
  }
  const stream = wrap({
    streamFn: createOpenAIResponsesTransportStreamFn(),
    provider: model.provider,
    modelId: model.id,
    config: cfg,
    extraParams: {
      ...cfg.agents?.defaults?.models?.["openai/gpt-test-a"]?.params,
      fastMode: sessionEntry.fastMode,
    },
  });
  if (!stream) {
    throw new Error("Expected wrapped SDK stream");
  }
  const output = await stream(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { apiKey: "synthetic-test-key" },
  );
  expect((await output.result()).errorMessage).toBe("captured before sending");
  return requests.at(-1);
}

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

function createControlsFixture(
  scope: string,
  sharingRole: GatewaySessionRow["sharingRole"] = "owner",
  globalTarget?: { sessionKey: string; rowAgentId: string },
) {
  const speedPreference: Pick<GatewaySessionRow, "fastMode" | "effectiveFastMode"> = {
    fastMode: false,
  };
  const selectedSession = {
    key: globalTarget ? "global" : "agent:main:existing",
    ...(globalTarget ? { agentId: globalTarget.rowAgentId } : {}),
    kind: globalTarget ? "global" : "direct",
    sessionId: "existing-session",
    sharingRole,
    model: "gpt-test-a",
    modelProvider: "openai",
    thinkingLevel: "low",
    ...speedPreference,
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
  const fixtureHost = makeChatHost({
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
  const pane = createRenderTestChatPane();
  const state = Object.assign(pane.initialize(createInitializationContext()), fixtureHost, {
    // This fixture supplies a complete model catalog, rather than a pending first load.
    chatModelCatalogInitialized: true,
  });
  const visibleSession = selectedChatSessionRow(state);
  const access = readChatPaneMutationAccess(
    {
      ...pane.context.gateway.snapshot,
      client: state.client,
      phase: "connected",
      hello: state.hello,
    },
    state.sessionKey,
    visibleSession,
  );
  const controls = renderControls(state, {
    selectedSession: visibleSession,
    modelAccess: access.model,
    effortAccess: access.effort,
    contextWindowAccess: access.contextWindow,
    permissionAccess: access.permission,
    canSelectFull: scope === "operator.admin",
  });
  const container = document.createElement("div");
  renderPaneLegacyContent(controls.composerControls, container);
  return { state, selectedSession, access, controls, container };
}

describe("chat pane model-setting permissions", () => {
  it.each(["flex", "auto"])(
    "persists Standard over inherited %s through the SDK request",
    async (tier) => {
      const { state, selectedSession, container } =
        createControlsFixture("operator.sessions.write");
      delete selectedSession.fastMode;
      selectedSession.effectiveFastMode = false;
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { "openai/gpt-test-a": { params: { serviceTier: tier } } } },
        },
      };
      renderPaneLegacyContent(renderControls(state).composerControls, container);
      const standard = container.querySelector<HTMLButtonElement>(
        '[data-chat-speed-option="off"]',
      )!;
      expect(standard.getAttribute("aria-checked")).toBe("true");
      expect(standard.disabled).toBe(false);
      expect(state.request).not.toHaveBeenCalled();
      expect(await captureSpeedRequest(cfg, selectedSession)).toMatchObject({ service_tier: tier });
      state.request.mockImplementation(async (method, params) => {
        if (method === "sessions.patch") {
          if (
            !params ||
            typeof params !== "object" ||
            !("fastMode" in params) ||
            params.fastMode !== false
          ) {
            throw new Error("Expected explicit Standard patch");
          }
          selectedSession.fastMode = params.fastMode;
          return { ok: true, key: selectedSession.key, entry: selectedSession };
        }
        return { ...createSessionsListResult(), sessions: [selectedSession] };
      });
      standard.click();
      await getPendingChatPickerPatch(state, state.sessionKey);
      expect(state.request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({
          key: selectedSession.key,
          expectedSessionId: selectedSession.sessionId,
          fastMode: false,
        }),
      );
      expect(await captureSpeedRequest(cfg, selectedSession)).toMatchObject({
        service_tier: "default",
      });
      state.request.mockClear();
      renderPaneLegacyContent(renderControls(state).composerControls, container);
      container.querySelector<HTMLButtonElement>('[data-chat-speed-option="off"]')!.click();
      expect(state.request).not.toHaveBeenCalled();
    },
  );
  it.each([
    { value: "off", saved: false },
    { value: "on", saved: true },
    { value: "ultrafast", saved: "ultrafast" },
  ] as const)(
    "saves $value during a response without interrupting it",
    async ({ value, saved }) => {
      const { state, selectedSession, container } =
        createControlsFixture("operator.sessions.write");
      selectedSession.fastMode = value !== "on";
      state.chatRunId = "running-response";
      state.chatStream = "Existing response";
      setChatRunOwner(state, state.chatRunId);
      state.chatModelCatalog[0] = {
        ...state.chatModelCatalog[0]!,
        available: true,
        serviceTiers: ["default", "priority", "ultrafast"],
      };
      renderPaneLegacyContent(renderControls(state).composerControls, container);
      container
        .querySelector<HTMLButtonElement>('[data-chat-speed-option="' + value + '"]')!
        .click();
      await getPendingChatPickerPatch(state, state.sessionKey);
      expect(state.request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({
          key: selectedSession.key,
          fastMode: saved,
          expectedSessionId: selectedSession.sessionId,
        }),
      );
      expect(
        state.request.mock.calls.some(
          ([method]) => method === "chat.abort" || method === "chat.send",
        ),
      ).toBe(false);
      expect(state.chatRunId).toBe("running-response");
      expect(state.chatStream).toBe("Existing response");
    },
  );
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
