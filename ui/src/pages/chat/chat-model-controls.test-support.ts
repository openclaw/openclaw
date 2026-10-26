import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, ModelCatalogEntry, SessionsListResult } from "../../api/types.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import type { SessionPatchResult } from "../../lib/sessions/patch.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "../../test-helpers/chat-model.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { switchChatModel, switchChatSetting } from "./chat-session.ts";
import { renderChatModelControls } from "./chat-view.test-helpers.ts";
import type { ChatModelControls } from "./components/chat-model-controls.tsx";

type ChatHeaderTestState = {
  chatLoading: boolean;
  chatMessages: unknown[];
  chatModelCatalog: ModelCatalogEntry[];
  chatRunId: string | null;
  chatSending: boolean;
  chatStream: string | null;
  client: GatewayBrowserClient;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  sessionKey: string;
  sessionsResult: SessionsListResult | null;
  agentsList: null;
  sessions: SessionCapability;
};

export function createChatHeaderState(
  overrides: {
    model?: string | null;
    modelProvider?: string | null;
    modelOverrideSource?: GatewaySessionRow["modelOverrideSource"];
    models?: ModelCatalogEntry[];
    defaultsThinkingDefault?: string;
    thinkingDefault?: string;
    thinkingLevels?: GatewaySessionRow["thinkingLevels"];
    omitSessionFromList?: boolean;
  } = {},
): { state: ChatHeaderTestState; request: ReturnType<typeof vi.fn> } {
  let currentModel = overrides.model ?? null;
  let currentModelProvider = overrides.modelProvider ?? (currentModel ? "openai" : null);
  const omitSessionFromList = overrides.omitSessionFromList ?? false;
  const catalog = overrides.models ?? createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG);
  const listSessions = () =>
    createSessionsListResult({
      model: currentModel,
      modelProvider: currentModelProvider,
      modelOverrideSource: overrides.modelOverrideSource,
      defaultsThinkingDefault: overrides.defaultsThinkingDefault,
      thinkingDefault: overrides.thinkingDefault,
      thinkingLevels: overrides.thinkingLevels,
      omitSessionFromList,
    });
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "sessions.patch") {
      if (Object.hasOwn(params, "model")) {
        const nextModel = (params.model as string | null | undefined) ?? null;
        if (!nextModel) {
          currentModel = null;
          currentModelProvider = null;
        } else {
          const normalized = nextModel.trim();
          const slashIndex = normalized.indexOf("/");
          if (slashIndex > 0) {
            currentModelProvider = normalized.slice(0, slashIndex);
            currentModel = normalized.slice(slashIndex + 1);
          } else {
            currentModel = normalized;
            const matchingProviders: string[] = [];
            for (const entry of catalog) {
              if (entry.id === normalized && entry.provider) {
                matchingProviders.push(entry.provider);
              }
            }
            currentModelProvider =
              matchingProviders.length === 1
                ? expectDefined(matchingProviders[0], "single matching model provider")
                : currentModelProvider;
          }
        }
      }
      return {
        ok: true,
        path: "",
        key: "main",
        entry: { sessionId: "main" },
      } satisfies SessionPatchResult;
    }
    if (method === "chat.history") {
      return { messages: [], thinkingLevel: null };
    }
    if (method === "sessions.list") {
      return listSessions();
    }
    if (method === "models.list") {
      return { models: catalog };
    }
    if (method === "tools.effective") {
      return {
        agentId: "main",
        profile: "coding",
        groups: [],
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const sessions = createTestSessionCapability({
    snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  const initialSessionsResult = listSessions();
  const state: ChatHeaderTestState = {
    sessionKey: "main",
    connected: true,
    sessionsResult: initialSessionsResult,
    chatModelCatalog: catalog,
    client,
    chatStream: null,
    chatRunId: null,
    chatMessages: [],
    chatLoading: false,
    chatSending: false,
    lastError: null,
    hello: sessionMutationGatewayHello(),
    agentsList: null,
    sessions,
  };
  sessions.subscribe((next) => {
    state.sessionsResult = next.result;
  });
  return { state, request };
}

type ChatModelControlsProps = Parameters<typeof ChatModelControls>[0];

function createChatModelControlsProps(state: ChatHeaderTestState): ChatModelControlsProps {
  const selectedSession = state.sessionsResult?.sessions.find((row) =>
    areUiSessionKeysEquivalent(row.key, state.sessionKey),
  );
  return {
    activeRunId: state.chatRunId,
    connected: state.connected,
    gatewayAvailable: Boolean(state.client),
    loading: state.chatLoading,
    modelCatalog: state.chatModelCatalog,
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    modelOverrides: state.sessions.state.modelOverrides,
    modelSelectionLocked: selectedSession?.modelSelectionLocked,
    modelSelectionTarget: state.sessionsResult?.defaults.modelSelectionTarget,
    modelSwitching: false,
    sending: state.chatSending,
    sessionKey: state.sessionKey,
    selectedSession,
    sessionsResult: state.sessionsResult,
    stream: state.chatStream,
    onFastModeSelect: (value, targetSessionKey) =>
      switchChatSetting(state, { kind: "fastMode", value }, targetSessionKey),
    onModelSelect: (value, targetSessionKey, agentRuntime) =>
      switchChatModel(state, value, targetSessionKey, agentRuntime),
    onThinkingSelect: (value, targetSessionKey) =>
      switchChatSetting(state, { kind: "thinkingLevel", value }, targetSessionKey),
  };
}

export const renderModelControls = (
  state: ChatHeaderTestState,
  overrides: Partial<ChatModelControlsProps> = {},
  container = document.createElement("div"),
) => renderChatModelControls({ ...createChatModelControlsProps(state), ...overrides }, container);
