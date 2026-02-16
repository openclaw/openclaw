import type { Component, TUI } from "@mariozechner/pi-tui";
import { randomUUID } from "node:crypto";
import type { SessionsPatchResult } from "../gateway/protocol/index.js";
import type { ChatLog } from "./components/chat-log.js";
import type { GatewayChatClient } from "./gateway-chat.js";
import type {
  AgentSummary,
  GatewayStatusSummary,
  TuiOptions,
  TuiStateAccess,
} from "./tui-types.js";
import {
  formatThinkingLevels,
  normalizeUsageDisplay,
  resolveResponseUsageMode,
} from "../auto-reply/thinking.js";
import { formatRelativeTimestamp } from "../infra/format-time/format-relative.ts";
import { normalizeAgentId } from "../routing/session-key.js";
import { helpText, parseCommand } from "./commands.js";
import {
  createFilterableSelectList,
  createSearchableSelectList,
  createSettingsList,
} from "./components/selectors.js";
import {
  getActiveThemeName,
  hasTheme,
  listThemeNames,
  setActiveTheme,
} from "./theme/theme-registry.js";
import { formatStatusSummary } from "./tui-status-summary.js";

type CommandHandlerContext = {
  client: GatewayChatClient;
  chatLog: ChatLog;
  tui: TUI;
  opts: TuiOptions;
  state: TuiStateAccess;
  deliverDefault: boolean;
  openOverlay: (component: Component) => void;
  closeOverlay: () => void;
  refreshSessionInfo: () => Promise<void>;
  loadHistory: () => Promise<void>;
  setSession: (key: string) => Promise<void>;
  refreshAgents: () => Promise<void>;
  abortActive: () => Promise<void>;
  setActivityStatus: (text: string) => void;
  formatSessionKey: (key: string) => string;
  applySessionInfoFromPatch: (result: SessionsPatchResult) => void;
  noteLocalRunId: (runId: string) => void;
  forgetLocalRunId?: (runId: string) => void;
};

export function createCommandHandlers(context: CommandHandlerContext) {
  const {
    client,
    chatLog,
    tui,
    opts,
    state,
    deliverDefault,
    openOverlay,
    closeOverlay,
    refreshSessionInfo,
    loadHistory,
    setSession,
    refreshAgents,
    abortActive,
    setActivityStatus,
    formatSessionKey,
    applySessionInfoFromPatch,
    noteLocalRunId,
    forgetLocalRunId,
  } = context;

  const setAgent = async (id: string) => {
    state.currentAgentId = normalizeAgentId(id);
    await setSession("");
  };

  const openModelSelector = async () => {
    try {
      const models = await client.listModels();
      if (models.length === 0) {
        chatLog.addSystem("no models available");
        tui.requestRender();
        return;
      }
      const items = models.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description: model.name && model.name !== model.id ? model.name : "",
      }));
      const selector = createSearchableSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          try {
            const result = await client.patchSession({
              key: state.currentSessionKey,
              model: item.value,
            });
            chatLog.addSystem(`model set to ${item.value}`);
            applySessionInfoFromPatch(result);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(`model set failed: ${String(err)}`);
          }
          closeOverlay();
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(`model list failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const openAgentSelector = async () => {
    await refreshAgents();
    if (state.agents.length === 0) {
      chatLog.addSystem("no agents found");
      tui.requestRender();
      return;
    }
    const items = state.agents.map((agent: AgentSummary) => ({
      value: agent.id,
      label: agent.name ? `${agent.id} (${agent.name})` : agent.id,
      description: agent.id === state.agentDefaultId ? "default" : "",
    }));
    const selector = createSearchableSelectList(items, 9);
    selector.onSelect = (item) => {
      void (async () => {
        closeOverlay();
        await setAgent(item.value);
        tui.requestRender();
      })();
    };
    selector.onCancel = () => {
      closeOverlay();
      tui.requestRender();
    };
    openOverlay(selector);
    tui.requestRender();
  };

  const openSessionSelector = async () => {
    try {
      const result = await client.listSessions({
        includeGlobal: false,
        includeUnknown: false,
        includeDerivedTitles: true,
        includeLastMessage: true,
        agentId: state.currentAgentId,
      });
      const items = result.sessions.map((session) => {
        const title = session.derivedTitle ?? session.displayName;
        const formattedKey = formatSessionKey(session.key);
        // Avoid redundant "title (key)" when title matches key
        const label = title && title !== formattedKey ? `${title} (${formattedKey})` : formattedKey;
        // Build description: time + message preview
        const timePart = session.updatedAt
          ? formatRelativeTimestamp(session.updatedAt, { dateFallback: true, fallback: "" })
          : "";
        const preview = session.lastMessagePreview?.replace(/\s+/g, " ").trim();
        const description =
          timePart && preview ? `${timePart} · ${preview}` : (preview ?? timePart);
        return {
          value: session.key,
          label,
          description,
          searchText: [
            session.displayName,
            session.label,
            session.subject,
            session.sessionId,
            session.key,
            session.lastMessagePreview,
          ]
            .filter(Boolean)
            .join(" "),
        };
      });
      const selector = createFilterableSelectList(items, 9);
      selector.onSelect = (item) => {
        void (async () => {
          closeOverlay();
          await setSession(item.value);
          tui.requestRender();
        })();
      };
      selector.onCancel = () => {
        closeOverlay();
        tui.requestRender();
      };
      openOverlay(selector);
      tui.requestRender();
    } catch (err) {
      chatLog.addSystem(`sessions list failed: ${String(err)}`);
      tui.requestRender();
    }
  };

  const openSettings = () => {
    const items = [
      {
        id: "tools",
        label: "Tool output",
        currentValue: state.toolsExpanded ? "expanded" : "collapsed",
        values: ["collapsed", "expanded"],
      },
      {
        id: "thinking",
        label: "Show thinking",
        currentValue: state.showThinking ? "on" : "off",
        values: ["off", "on"],
      },
    ];
    const settings = createSettingsList(
      items,
      (id, value) => {
        if (id === "tools") {
          state.toolsExpanded = value === "expanded";
          chatLog.setToolsExpanded(state.toolsExpanded);
        }
        if (id === "thinking") {
          state.showThinking = value === "on";
          void loadHistory();
        }
        tui.requestRender();
      },
      () => {
        closeOverlay();
        tui.requestRender();
      },
    );
    openOverlay(settings);
    tui.requestRender();
  };

  const handleCommand = async (raw: string) => {
    const { name, args } = parseCommand(raw);
    if (!name) {
      return;
    }
    switch (name) {
      case "help":
        chatLog.addSystem(
          helpText({
            provider: state.sessionInfo.modelProvider,
            model: state.sessionInfo.model,
          }),
        );
        break;
      case "status":
        try {
          const status = await client.getStatus();
          if (typeof status === "string") {
            chatLog.addSystem(status);
            break;
          }
          if (status && typeof status === "object") {
            const lines = formatStatusSummary(status as GatewayStatusSummary);
            for (const line of lines) {
              chatLog.addSystem(line);
            }
            break;
          }
          chatLog.addSystem("status: unknown response");
        } catch (err) {
          chatLog.addSystem(`status failed: ${String(err)}`);
        }
        break;
      case "agent":
        if (!args) {
          await openAgentSelector();
        } else {
          await setAgent(args);
        }
        break;
      case "agents":
        await openAgentSelector();
        break;
      case "session":
        if (!args) {
          await openSessionSelector();
        } else {
          await setSession(args);
        }
        break;
      case "sessions":
        await openSessionSelector();
        break;
      case "model":
        if (!args) {
          await openModelSelector();
        } else {
          try {
            const result = await client.patchSession({
              key: state.currentSessionKey,
              model: args,
            });
            chatLog.addSystem(`model set to ${args}`);
            applySessionInfoFromPatch(result);
            await refreshSessionInfo();
          } catch (err) {
            chatLog.addSystem(`model set failed: ${String(err)}`);
          }
        }
        break;
      case "models":
        await openModelSelector();
        break;
      case "think":
        if (!args) {
          const levels = formatThinkingLevels(
            state.sessionInfo.modelProvider,
            state.sessionInfo.model,
            "|",
          );
          chatLog.addSystem(`usage: /think <${levels}>`);
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            thinkingLevel: args,
          });
          chatLog.addSystem(`thinking set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`think failed: ${String(err)}`);
        }
        break;
      case "verbose": {
        if (!args) {
          chatLog.addSystem("usage: /verbose <off|compact|full>");
          break;
        }
        // Map user-facing "compact" to the server-side "on" value.
        const verboseArg = args === "compact" ? "on" : args;
        const verboseLabel = verboseArg === "on" ? "compact" : args;
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            verboseLevel: verboseArg,
          });
          // Sync local toolsExpanded state with the verbose level.
          state.toolsExpanded = verboseArg === "full";
          chatLog.setToolsExpanded(state.toolsExpanded);
          chatLog.addSystem(`verbose set to ${verboseLabel}`);
          applySessionInfoFromPatch(result);
          await loadHistory();
        } catch (err) {
          chatLog.addSystem(`verbose failed: ${String(err)}`);
        }
        break;
      }
      case "reasoning":
        if (!args) {
          chatLog.addSystem("usage: /reasoning <on|off>");
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            reasoningLevel: args,
          });
          chatLog.addSystem(`reasoning set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`reasoning failed: ${String(err)}`);
        }
        break;
      case "usage": {
        const normalized = args ? normalizeUsageDisplay(args) : undefined;
        if (args && !normalized) {
          chatLog.addSystem("usage: /usage <off|tokens|full>");
          break;
        }
        const currentRaw = state.sessionInfo.responseUsage;
        const current = resolveResponseUsageMode(currentRaw);
        const next =
          normalized ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            responseUsage: next === "off" ? null : next,
          });
          chatLog.addSystem(`usage footer: ${next}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`usage failed: ${String(err)}`);
        }
        break;
      }
      case "elevated":
        if (!args) {
          chatLog.addSystem("usage: /elevated <on|off|ask|full>");
          break;
        }
        if (!["on", "off", "ask", "full"].includes(args)) {
          chatLog.addSystem("usage: /elevated <on|off|ask|full>");
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            elevatedLevel: args,
          });
          chatLog.addSystem(`elevated set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`elevated failed: ${String(err)}`);
        }
        break;
      case "activation":
        if (!args) {
          chatLog.addSystem("usage: /activation <mention|always>");
          break;
        }
        try {
          const result = await client.patchSession({
            key: state.currentSessionKey,
            groupActivation: args === "always" ? "always" : "mention",
          });
          chatLog.addSystem(`activation set to ${args}`);
          applySessionInfoFromPatch(result);
          await refreshSessionInfo();
        } catch (err) {
          chatLog.addSystem(`activation failed: ${String(err)}`);
        }
        break;
      case "theme": {
        if (!args) {
          const names = listThemeNames();
          const current = getActiveThemeName();
          chatLog.addSystem(`Current theme: ${current}\nAvailable: ${names.join(", ")}`);
          break;
        }
        if (hasTheme(args)) {
          setActiveTheme(args);
          chatLog.addSystem(`theme set to ${args}`);
        } else {
          chatLog.addSystem(`unknown theme: ${args}\nAvailable: ${listThemeNames().join(", ")}`);
        }
        break;
      }
      case "context": {
        const info = state.sessionInfo;
        const total = info.totalTokens ?? 0;
        const context = info.contextTokens ?? 0;
        const input = info.inputTokens ?? 0;
        const output = info.outputTokens ?? 0;
        if (!context) {
          chatLog.addSystem("No context window info available. Send a message first.");
          break;
        }
        const pct = Math.min(100, Math.round((total / context) * 100));
        const barWidth = 40;
        const filled = Math.round((pct / 100) * barWidth);
        const empty = barWidth - filled;
        const barChar = pct > 80 ? "█" : pct > 50 ? "▓" : "░";
        const bar = barChar.repeat(filled) + "·".repeat(empty);
        const color = pct > 80 ? "🔴" : pct > 50 ? "🟡" : "🟢";
        const lines = [
          `${color} Context window: ${pct}% used`,
          `[${bar}] ${total.toLocaleString()} / ${context.toLocaleString()} tokens`,
          `  Input: ${input.toLocaleString()} | Output: ${output.toLocaleString()} | Remaining: ${(context - total).toLocaleString()}`,
        ];
        chatLog.addSystem(lines.join("\n"));
        break;
      }
      case "export": {
        const exportParts = args.split(/\s+/);
        const format = exportParts[0] || "markdown";
        if (!["markdown", "json"].includes(format)) {
          chatLog.addSystem("usage: /export <markdown|json> [path]");
          break;
        }
        try {
          const raw = await client.loadHistory({ sessionKey: state.currentSessionKey });
          // The gateway returns either an array directly or an object with messages/entries.
          const entries: unknown[] = Array.isArray(raw)
            ? raw
            : raw && typeof raw === "object" && Array.isArray(raw.messages)
              ? (raw.messages as unknown[])
              : raw && typeof raw === "object" && Array.isArray(raw.entries)
                ? (raw.entries as unknown[])
                : [];
          if (entries.length === 0) {
            chatLog.addSystem("no conversation history to export");
            break;
          }
          let content: string;
          if (format === "json") {
            content = JSON.stringify(entries, null, 2);
          } else {
            const mdLines: string[] = [];
            mdLines.push(`# Conversation Export`);
            mdLines.push(`Session: ${state.currentSessionKey}`);
            mdLines.push(`Date: ${new Date().toISOString()}`);
            mdLines.push("");
            for (const entry of entries) {
              const msg = (entry && typeof entry === "object" ? entry : {}) as Record<
                string,
                unknown
              >;
              const rawRole = msg.role;
              const role = typeof rawRole === "string" ? rawRole : "unknown";
              const rawText = msg.text ?? msg.content;
              const text = typeof rawText === "string" ? rawText : "";
              mdLines.push(`## ${role.charAt(0).toUpperCase() + role.slice(1)}`);
              mdLines.push(text);
              mdLines.push("");
            }
            content = mdLines.join("\n");
          }
          const pathArg = exportParts.slice(1).join(" ").trim();
          if (pathArg) {
            const fs = await import("node:fs/promises");
            await fs.writeFile(pathArg, content, "utf-8");
            chatLog.addSystem(`exported ${format} to ${pathArg} (${entries.length} messages)`);
          } else {
            chatLog.addSystem(
              `Export (${entries.length} messages, ${content.length} chars, ${format}):\n${content.slice(0, 500)}${content.length > 500 ? "\n… (truncated, use /export markdown <path> to save)" : ""}`,
            );
          }
        } catch (err) {
          chatLog.addSystem(`export failed: ${String(err)}`);
        }
        break;
      }
      case "doctor": {
        const checks: string[] = [];
        // Connection check
        checks.push(state.isConnected ? "✓ Gateway connected" : "✗ Gateway disconnected");
        // Model check
        const model = state.sessionInfo.model;
        checks.push(
          model
            ? `✓ Model: ${state.sessionInfo.modelProvider ?? ""}/${model}`
            : "✗ No model configured",
        );
        // Context window check
        const ctxTokens = state.sessionInfo.contextTokens;
        const totalTokens = state.sessionInfo.totalTokens ?? 0;
        if (ctxTokens) {
          const pctUsed = Math.round((totalTokens / ctxTokens) * 100);
          checks.push(
            pctUsed > 80
              ? `⚠ Context: ${pctUsed}% used (${totalTokens.toLocaleString()}/${ctxTokens.toLocaleString()})`
              : `✓ Context: ${pctUsed}% used`,
          );
        } else {
          checks.push("- Context: not available yet");
        }
        // Session check
        checks.push(`✓ Session: ${state.currentSessionKey}`);
        checks.push(`✓ Agent: ${state.currentAgentId}`);
        // Verbose check
        const verbLevel = state.sessionInfo.verboseLevel ?? "off";
        checks.push(`  Verbose: ${verbLevel === "on" ? "compact" : verbLevel}`);
        // Health from gateway
        try {
          const status = await client.getStatus();
          if (status && typeof status === "object") {
            const summary = status as GatewayStatusSummary;
            if (summary.providerSummary?.length) {
              checks.push(`✓ Providers: ${summary.providerSummary.join(", ")}`);
            }
            if (summary.mcpServers?.length) {
              checks.push(
                `✓ MCP Servers: ${summary.mcpServers.map((s) => `${s.name} (${s.tools} tools)`).join(", ")}`,
              );
            }
          }
        } catch {
          checks.push("⚠ Could not fetch gateway status");
        }
        chatLog.addSystem(`Diagnostics:\n${checks.join("\n")}`);
        break;
      }
      case "stats": {
        const info = state.sessionInfo;
        const lines: string[] = [];
        lines.push("Session Statistics:");
        lines.push(`  Model: ${info.modelProvider ?? "?"}/${info.model ?? "?"}`);
        lines.push(`  Thinking: ${info.thinkingLevel ?? "off"}`);
        lines.push(
          `  Verbose: ${(info.verboseLevel ?? "off") === "on" ? "compact" : (info.verboseLevel ?? "off")}`,
        );
        lines.push(`  Reasoning: ${info.reasoningLevel ?? "off"}`);
        if (info.contextTokens) {
          const used = info.totalTokens ?? 0;
          const remaining = info.contextTokens - used;
          const pct = Math.round((used / info.contextTokens) * 100);
          lines.push(
            `  Context: ${used.toLocaleString()} / ${info.contextTokens.toLocaleString()} (${pct}%)`,
          );
          lines.push(`  Remaining: ${remaining.toLocaleString()} tokens`);
        }
        if (info.inputTokens != null) {
          lines.push(`  Input tokens: ${info.inputTokens.toLocaleString()}`);
        }
        if (info.outputTokens != null) {
          lines.push(`  Output tokens: ${info.outputTokens.toLocaleString()}`);
        }
        chatLog.addSystem(lines.join("\n"));
        break;
      }
      case "new":
      case "reset":
        try {
          // Clear token counts immediately to avoid stale display (#1523)
          state.sessionInfo.inputTokens = null;
          state.sessionInfo.outputTokens = null;
          state.sessionInfo.totalTokens = null;
          tui.requestRender();

          await client.resetSession(state.currentSessionKey, name);
          chatLog.addSystem(`session ${state.currentSessionKey} reset`);
          await loadHistory();
        } catch (err) {
          chatLog.addSystem(`reset failed: ${String(err)}`);
        }
        break;
      case "abort":
        await abortActive();
        break;
      case "settings":
        openSettings();
        break;
      case "exit":
      case "quit":
        client.stop();
        tui.stop();
        process.exit(0);
        break;
      default:
        await sendMessage(raw);
        break;
    }
    tui.requestRender();
  };

  const sendMessage = async (text: string) => {
    try {
      chatLog.addUser(text);
      tui.requestRender();
      const runId = randomUUID();
      noteLocalRunId(runId);
      state.activeChatRunId = runId;
      setActivityStatus("sending");
      await client.sendChat({
        sessionKey: state.currentSessionKey,
        message: text,
        thinking: opts.thinking,
        deliver: deliverDefault,
        timeoutMs: opts.timeoutMs,
        runId,
      });
      setActivityStatus("waiting");
    } catch (err) {
      if (state.activeChatRunId) {
        forgetLocalRunId?.(state.activeChatRunId);
      }
      state.activeChatRunId = null;
      chatLog.addSystem(`send failed: ${String(err)}`);
      setActivityStatus("error");
    }
    tui.requestRender();
  };

  return {
    handleCommand,
    sendMessage,
    openModelSelector,
    openAgentSelector,
    openSessionSelector,
    openSettings,
    setAgent,
  };
}
