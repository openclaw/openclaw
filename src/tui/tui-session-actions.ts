import type { TUI } from "@mariozechner/pi-tui";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import type { ChatLog } from "./components/chat-log.js";
import type { GatewayAgentsList, GatewayChatClient } from "./gateway-chat.js";
import { asString, extractTextFromMessage, isCommandMessage } from "./tui-formatters.js";
import type { TuiOptions, TuiStateAccess } from "./tui-types.js";

type SessionActionContext = {
  client: GatewayChatClient;
  chatLog: ChatLog;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  agentNames: Map<string, string>;
  initialSessionInput: string;
  initialSessionAgentId: string | null;
  resolveSessionKey: (raw?: string) => string;
  updateHeader: () => void;
  updateFooter: () => void;
  updateAutocompleteProvider: () => void;
  setActivityStatus: (text: string) => void;
};

export function createSessionActions(context: SessionActionContext) {
  const {
    client,
    chatLog,
    tui,
    opts,
    state,
    agentNames,
    initialSessionInput,
    initialSessionAgentId,
    resolveSessionKey,
    updateHeader,
    updateFooter,
    updateAutocompleteProvider,
    setActivityStatus,
  } = context;
  let refreshSessionInfoPromise: Promise<void> | null = null;

  const applyAgentsResult = (result: GatewayAgentsList) => {
    state.agentDefaultId = normalizeAgentId(result.defaultId);
    state.sessionMainKey = normalizeMainKey(result.mainKey);
    state.sessionScope = result.scope ?? state.sessionScope;
    state.agents = result.agents.map((agent) => ({
      id: normalizeAgentId(agent.id),
      name: agent.name?.trim() || undefined,
    }));
    agentNames.clear();
    for (const agent of state.agents) {
      if (agent.name) agentNames.set(agent.id, agent.name);
    }
    if (!state.initialSessionApplied) {
      if (initialSessionAgentId) {
        if (state.agents.some((agent) => agent.id === initialSessionAgentId)) {
          state.currentAgentId = initialSessionAgentId;
        }
      } else if (!state.agents.some((agent) => agent.id === state.currentAgentId)) {
        state.currentAgentId =
          state.agents[0]?.id ?? normalizeAgentId(result.defaultId ?? state.currentAgentId);
      }
      const nextSessionKey = resolveSessionKey(initialSessionInput);
      if (nextSessionKey !== state.currentSessionKey) {
        state.currentSessionKey = nextSessionKey;
      }
      state.initialSessionApplied = true;
    } else if (!state.agents.some((agent) => agent.id === state.currentAgentId)) {
      state.currentAgentId =
        state.agents[0]?.id ?? normalizeAgentId(result.defaultId ?? state.currentAgentId);
    }
    updateHeader();
    updateFooter();
  };

  const refreshAgents = async () => {
    try {
      const result = await client.listAgents();
      applyAgentsResult(result);
    } catch (err) {
      chatLog.addSystem(`agents list failed: ${String(err)}`);
    }
  };

  const updateAgentFromSessionKey = (key: string) => {
    const parsed = parseAgentSessionKey(key);
    if (!parsed) return;
    const next = normalizeAgentId(parsed.agentId);
    if (next !== state.currentAgentId) {
      state.currentAgentId = next;
    }
  };

  const refreshSessionInfo = async () => {
    if (refreshSessionInfoPromise) return refreshSessionInfoPromise;
    refreshSessionInfoPromise = (async () => {
      try {
        const listAgentId =
          state.currentSessionKey === "global" || state.currentSessionKey === "unknown"
            ? undefined
            : state.currentAgentId;
        const result = await client.listSessions({
          includeGlobal: false,
          includeUnknown: false,
          agentId: listAgentId,
        });
        const entry = result.sessions.find((row) => {
          // Exact match
          if (row.key === state.currentSessionKey) return true;
          // Also match canonical keys like "agent:default:main" against "main"
          const parsed = parseAgentSessionKey(row.key);
          return parsed?.rest === state.currentSessionKey;
        });
        state.sessionInfo = {
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          reasoningLevel: entry?.reasoningLevel,
          model: entry?.model ?? result.defaults?.model ?? undefined,
          modelProvider: entry?.modelProvider ?? result.defaults?.modelProvider ?? undefined,
          contextTokens: entry?.contextTokens ?? result.defaults?.contextTokens,
          inputTokens: entry?.inputTokens ?? null,
          outputTokens: entry?.outputTokens ?? null,
          totalTokens: entry?.totalTokens ?? null,
          responseUsage: entry?.responseUsage,
          updatedAt: entry?.updatedAt ?? null,
          displayName: entry?.displayName,
        };
      } catch (err) {
        chatLog.addSystem(`sessions list failed: ${String(err)}`);
      }
      updateAutocompleteProvider();
      updateFooter();
      tui.requestRender();
    })();
    try {
      await refreshSessionInfoPromise;
    } finally {
      refreshSessionInfoPromise = null;
    }
  };

  const loadHistory = async () => {
    try {
      const history = await client.loadHistory({
        sessionKey: state.currentSessionKey,
        limit: opts.historyLimit ?? 200,
      });
      const record = history as {
        messages?: unknown[];
        sessionId?: string;
        thinkingLevel?: string;
      };
      state.currentSessionId = typeof record.sessionId === "string" ? record.sessionId : null;
      state.sessionInfo.thinkingLevel = record.thinkingLevel ?? state.sessionInfo.thinkingLevel;
      chatLog.clearAll();
      chatLog.addSystem(`session ${state.currentSessionKey}`);
      for (const entry of record.messages ?? []) {
        if (!entry || typeof entry !== "object") continue;
        const message = entry as Record<string, unknown>;
        if (isCommandMessage(message)) {
          const text = extractTextFromMessage(message);
          if (text) chatLog.addSystem(text);
          continue;
        }
        if (message.role === "user") {
          const text = extractTextFromMessage(message);
          if (text) chatLog.addUser(text);
          continue;
        }
        if (message.role === "assistant") {
          const text = extractTextFromMessage(message, {
            includeThinking: state.showThinking,
          });
          if (text) chatLog.finalizeAssistant(text);
          continue;
        }
        if (message.role === "toolResult") {
          const toolCallId = asString(message.toolCallId, "");
          const toolName = asString(message.toolName, "tool");
          const component = chatLog.startTool(toolCallId, toolName, {});
          component.setResult(
            {
              content: Array.isArray(message.content)
                ? (message.content as Record<string, unknown>[])
                : [],
              details:
                typeof message.details === "object" && message.details
                  ? (message.details as Record<string, unknown>)
                  : undefined,
            },
            { isError: Boolean(message.isError) },
          );
        }
      }
      state.historyLoaded = true;
    } catch (err) {
      chatLog.addSystem(`history failed: ${String(err)}`);
    }
    await refreshSessionInfo();
    tui.requestRender();
  };

  const setSession = async (rawKey: string) => {
    const nextKey = resolveSessionKey(rawKey);
    updateAgentFromSessionKey(nextKey);
    state.currentSessionKey = nextKey;
    state.activeChatRunId = null;
    state.currentSessionId = null;
    state.historyLoaded = false;
    updateHeader();
    updateFooter();
    await loadHistory();
  };

  const abortActive = async () => {
    if (!state.activeChatRunId) {
      chatLog.addSystem("no active run");
      tui.requestRender();
      return;
    }
    try {
      await client.abortChat({
        sessionKey: state.currentSessionKey,
        runId: state.activeChatRunId,
      });
      setActivityStatus("aborted");
    } catch (err) {
      chatLog.addSystem(`abort failed: ${String(err)}`);
      setActivityStatus("abort failed");
    }
    tui.requestRender();
  };

  return {
    applyAgentsResult,
    refreshAgents,
    refreshSessionInfo,
    loadHistory,
    setSession,
    abortActive,
  };
}
