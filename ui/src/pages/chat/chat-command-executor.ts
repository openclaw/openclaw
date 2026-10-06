import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import {
  isSessionDefaultDirectiveValue,
  normalizeVerboseLevel,
} from "../../../../src/auto-reply/thinking.shared.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  getSlashCommandCategoryLabel,
  getSlashCommandDescription,
  SLASH_COMMANDS,
} from "../../lib/chat/commands.ts";
import {
  normalizeChatFastModeInput,
  resolveChatFastModeStatus,
} from "../../lib/chat/model-select-state.ts";
import {
  formatThinkingCommandOptionsForSession,
  isThinkingLevelOptionForSession,
  resolveCurrentThinkingLevel,
  resolveThinkingLevelInput,
} from "../../lib/chat/thinking.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionContextLimit } from "../../lib/sessions/context-budget.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { normalizeChatSendAckStatus } from "./chat-send-ack.ts";
import { patchChatCommandSessionSettings, selectedGlobalScope } from "./chat-settings-patches.ts";

type SlashCommandResult = {
  /** Markdown-formatted result to display in chat. */
  content?: string;
  /** Side-effect action the caller should perform after displaying the result. */
  action?: "refresh";
  /** Model-dependent tools need refreshing after a confirmed selection. */
  modelChanged?: boolean;
  /** When set, the caller should track this as the active run (enables Abort, blocks concurrent sends). */
  trackRunId?: string;
  /** When set, the caller should surface a visible pending item tied to the current run. */
  pendingCurrentRun?: boolean;
  /** The command did not complete and a durable queued invocation may be retried. */
  failed?: boolean;
};

type SlashCommandContext = {
  sessions: SessionCapability;
  sessionAccessSnapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase">;
  readSessionAccessSnapshot?: () => Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase">;
  isCurrent?: () => boolean;
  chatModelCatalog?: ModelCatalogEntry[];
  defaultAgentId?: string;
  agentId?: string;
  ownsModelOverride?: () => boolean;
};

function commandFailure(key: string, error: unknown): SlashCommandResult {
  return { content: t(key, { error: formatUiError(error) }), failed: true };
}

function assertCurrentSlashCommand(context: SlashCommandContext): void {
  if (context.isCurrent?.() === false) {
    throw new Error("The Gateway connection changed. Retry the command.");
  }
}

function requireSessionMutationAccess(
  context: SlashCommandContext,
  request: Parameters<typeof readSessionMethodAccess>[1],
): void {
  assertCurrentSlashCommand(context);
  const access = readSessionMethodAccess(
    context.readSessionAccessSnapshot?.() ?? context.sessionAccessSnapshot,
    request,
  );
  if (!access.allowed) {
    throw new Error(access.reason);
  }
}

async function patchSession(
  context: SlashCommandContext,
  sessionKey: string,
  patch: Parameters<typeof patchChatCommandSessionSettings>[2],
  success: () => Pick<SlashCommandResult, "content" | "modelChanged">,
  failureKey: string,
  options?: Parameters<typeof patchChatCommandSessionSettings>[3],
): Promise<SlashCommandResult> {
  try {
    requireSessionMutationAccess(context, {
      method: "sessions.patch",
      params: { key: sessionKey, ...selectedGlobalScope(sessionKey, context), ...patch },
    });
    await patchChatCommandSessionSettings(context, sessionKey, patch, options);
    return { ...success(), action: "refresh" };
  } catch (err) {
    return commandFailure(failureKey, err);
  }
}

export async function executeSlashCommand(
  client: GatewayBrowserClient,
  sessionKey: string,
  commandName: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  switch (commandName) {
    case "help":
      return executeHelp();
    case "compact":
      return await executeCompact(sessionKey, context);
    case "model":
      return await executeModel(client, sessionKey, args, context);
    case "think":
      return await executeThink(client, sessionKey, args, context);
    case "fast":
      return await executeFast(sessionKey, args, context);
    case "verbose":
      return await executeVerbose(sessionKey, args, context);
    case "usage":
      return await executeUsage(sessionKey, context);
    case "agents":
      return await executeAgents(client);
    case "steer":
    case "redirect":
      return await executeRunCommand(client, sessionKey, args, context, commandName);
    default:
      return {
        content: t("chat.commandResults.unknownCommand", { command: `/${commandName}` }),
      };
  }
}

function executeHelp(): SlashCommandResult {
  const lines = [`**${t("chat.commandResults.help.availableCommands")}**\n`];
  let currentCategory = "";

  for (const cmd of SLASH_COMMANDS) {
    const cat = cmd.category ?? "session";
    if (cat !== currentCategory) {
      currentCategory = cat;
      lines.push(`**${getSlashCommandCategoryLabel(cat)}**`);
    }
    const argStr = cmd.args ? ` ${cmd.args}` : "";
    const local = cmd.executeLocal ? "" : ` *(${t("chat.commandResults.help.agentCommand")})*`;
    lines.push(`\`/${cmd.name}${argStr}\` — ${getSlashCommandDescription(cmd)}${local}`);
  }

  lines.push(`\n${t("chat.commandResults.help.openMenu")}`);
  return { content: lines.join("\n") };
}

async function executeCompact(
  sessionKey: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const options = selectedGlobalScope(sessionKey, context);
    requireSessionMutationAccess(context, {
      method: "sessions.compact",
      requiredScope: "operator.admin",
    });
    const result = await context.sessions.compact(sessionKey, options);
    if (result?.ok !== true) {
      const reason = typeof result?.reason === "string" ? formatUiExternalText(result.reason) : "";
      return {
        content: reason
          ? t("chat.commandResults.compaction.failedWithReason", { reason })
          : t("chat.commandResults.compaction.failed"),
        failed: true,
      };
    }
    if (result?.compacted) {
      return {
        action: "refresh",
      };
    }
    if (typeof result?.reason === "string" && result.reason.trim()) {
      return {
        content: t("chat.commandResults.compaction.skippedWithReason", {
          reason: formatUiExternalText(result.reason),
        }),
        action: "refresh",
      };
    }
    return { content: t("chat.commandResults.compaction.skipped"), action: "refresh" };
  } catch (err) {
    return {
      content: t("chat.commandResults.compaction.failedWithReason", { reason: formatUiError(err) }),
      failed: true,
    };
  }
}

async function executeModel(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  if (!args) {
    try {
      const { session, defaults, models } = await loadModelCommandState(
        client,
        context,
        sessionKey,
      );
      const model = session?.model || defaults?.model || "default";
      const available = models
        .filter((entry) => entry.available !== false && entry.manualSelectionAllowed !== false)
        .map((entry) => entry.id);
      const lines = [t("chat.commandResults.model.current", { model: `\`${model}\`` })];
      if (available.length > 0) {
        const remaining =
          available.length > 10
            ? t("chat.commandResults.model.more", { count: String(available.length - 10) })
            : "";
        lines.push(
          `${t("chat.commandResults.model.available", {
            models: available
              .slice(0, 10)
              .map((m) => `\`${m}\``)
              .join(", "),
          })}${remaining}`,
        );
      }
      return { content: lines.join("\n") };
    } catch (err) {
      return commandFailure("chat.commandResults.model.getFailed", err);
    }
  }

  const requestedModel = args.trim();
  return patchSession(
    context,
    sessionKey,
    { model: requestedModel },
    () => ({
      content: t("chat.commandResults.model.set", { model: `\`${requestedModel}\`` }),
      modelChanged: true,
    }),
    "chat.commandResults.model.setFailed",
    { ownsModelOverride: context.ownsModelOverride },
  );
}

async function executeThink(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const { session, defaults, models } = await loadModelCommandState(
        client,
        context,
        sessionKey,
      );
      return {
        content: formatDirectiveOptions(
          t("chat.commandResults.thinking.current", {
            level: resolveCurrentThinkingLevel(session, defaults, models),
          }),
          formatThinkingCommandOptionsForSession(session, defaults, models),
        ),
      };
    } catch (err) {
      return commandFailure("chat.commandResults.thinking.getFailed", err);
    }
  }

  if (isSessionDefaultDirectiveValue(rawLevel)) {
    return patchSession(
      context,
      sessionKey,
      { thinkingLevel: null },
      () => ({ content: t("chat.commandResults.thinking.reset") }),
      "chat.commandResults.thinking.resetFailed",
    );
  }

  try {
    const { session, defaults } = await loadCurrentSessionState(context, sessionKey);
    const modelCatalog = context.chatModelCatalog ?? [];
    const level = resolveThinkingLevelInput(rawLevel, session, defaults, modelCatalog);
    if (!level) {
      return {
        content: t("chat.commandResults.thinking.unrecognized", {
          level: rawLevel,
          options: formatThinkingCommandOptionsForSession(session, defaults, modelCatalog),
        }),
      };
    }
    if (isThinkingLevelOptionForSession(session, defaults, level, modelCatalog) === false) {
      return {
        content: t("chat.commandResults.thinking.unsupported", {
          level: rawLevel,
          options: formatThinkingCommandOptionsForSession(session, defaults, modelCatalog),
        }),
      };
    }
    return patchSession(
      context,
      sessionKey,
      { thinkingLevel: level },
      () => ({ content: t("chat.commandResults.thinking.set", { level: `**${level}**` }) }),
      "chat.commandResults.thinking.setFailed",
    );
  } catch (err) {
    return commandFailure("chat.commandResults.thinking.setFailed", err);
  }
}

async function executeVerbose(
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const { session } = await loadCurrentSessionState(context, sessionKey);
      return {
        content: formatDirectiveOptions(
          t("chat.commandResults.verbose.current", {
            level: normalizeVerboseLevel(session?.verboseLevel) ?? "off",
          }),
          "on, full, off",
        ),
      };
    } catch (err) {
      return commandFailure("chat.commandResults.verbose.getFailed", err);
    }
  }

  const level = normalizeVerboseLevel(rawLevel);
  if (!level) {
    return {
      content: t("chat.commandResults.verbose.unrecognized", { level: rawLevel }),
    };
  }

  return patchSession(
    context,
    sessionKey,
    { verboseLevel: level },
    () => ({ content: t("chat.commandResults.verbose.set", { level: `**${level}**` }) }),
    "chat.commandResults.verbose.setFailed",
  );
}

async function executeFast(
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const rawMode = normalizeLowercaseStringOrEmpty(args);

  if (!rawMode || rawMode === "status") {
    try {
      const { session } = await loadCurrentSessionState(context, sessionKey);
      return {
        content: formatDirectiveOptions(
          resolveChatFastModeStatus(session),
          t("chat.commandResults.fast.options", {
            seconds: String(session?.fastAutoOnSeconds ?? 60),
          }),
        ),
      };
    } catch (err) {
      return commandFailure("chat.commandResults.fast.getFailed", err);
    }
  }

  if (isSessionDefaultDirectiveValue(rawMode)) {
    return patchSession(
      context,
      sessionKey,
      { fastMode: null },
      () => ({ content: t("chat.commandResults.fast.reset") }),
      "chat.commandResults.fast.resetFailed",
    );
  }

  const nextMode = normalizeChatFastModeInput(rawMode);
  if (nextMode === undefined) {
    return {
      content: t("chat.commandResults.fast.unrecognized", { mode: args.trim() }),
    };
  }

  return patchSession(
    context,
    sessionKey,
    { fastMode: nextMode },
    () => ({
      content:
        nextMode === "auto"
          ? t("chat.commandResults.fast.setAuto")
          : t(nextMode ? "chat.commandResults.fast.enabled" : "chat.commandResults.fast.disabled"),
    }),
    "chat.commandResults.fast.setFailed",
  );
}

async function executeUsage(
  sessionKey: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const { session } = await loadCurrentSessionState(context, sessionKey);
    if (!session) {
      return { content: t("chat.commandResults.usage.noActiveThread") };
    }
    const hasInputTokens = Number.isFinite(session.inputTokens);
    const hasOutputTokens = Number.isFinite(session.outputTokens);
    const input = hasInputTokens ? (session.inputTokens ?? 0) : 0;
    const output = hasOutputTokens ? (session.outputTokens ?? 0) : 0;
    const cumulativeTotal = hasInputTokens || hasOutputTokens ? input + output : null;
    const contextSnapshotTotal = Number.isFinite(session.totalTokens)
      ? (session.totalTokens ?? null)
      : cumulativeTotal;
    const totalTokensFresh = session.totalTokensFresh !== false;
    const limit = resolveSessionContextLimit(session);
    const ctx = limit.tokens;
    const pct =
      contextSnapshotTotal !== null && totalTokensFresh && ctx > 0
        ? Math.round((contextSnapshotTotal / ctx) * 100)
        : null;
    const totalDisplay =
      cumulativeTotal === null
        ? t("chat.commandResults.usage.notAvailable")
        : `${totalTokensFresh ? "" : "~"}${formatCompactTokenCount(cumulativeTotal)}`;

    const lines = [
      `**${t("chat.commandResults.usage.title")}**`,
      t("chat.commandResults.usage.inputTokens", {
        count: `**${formatCompactTokenCount(input)}**`,
      }),
      t("chat.commandResults.usage.outputTokens", {
        count: `**${formatCompactTokenCount(output)}**`,
      }),
      t("chat.commandResults.usage.totalTokens", { count: `**${totalDisplay}**` }),
    ];
    if (pct !== null) {
      lines.push(
        t(
          limit.fromLastPrompt
            ? "chat.commandResults.usage.promptBudget"
            : "chat.commandResults.usage.context",
          {
            percent: `**${pct}%**`,
            total: formatCompactTokenCount(ctx),
          },
        ),
      );
    }
    if (session.model) {
      lines.push(t("chat.commandResults.usage.model", { model: `\`${session.model}\`` }));
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return commandFailure("chat.commandResults.usage.failed", err);
  }
}

async function executeAgents(client: GatewayBrowserClient): Promise<SlashCommandResult> {
  try {
    const result = await client.request<AgentsListResult>("agents.list", {});
    const agents = result?.agents ?? [];
    if (agents.length === 0) {
      return { content: t("chat.commandResults.agents.none") };
    }
    const lines = [t("chat.commandResults.agents.title", { count: String(agents.length) }), ""];
    for (const agent of agents) {
      const isDefault = agent.id === result?.defaultId;
      const name = agent.identity?.name || agent.name || agent.id;
      const marker = isDefault ? ` *(${t("chat.commandResults.agents.default")})*` : "";
      const runtime = agent.agentRuntime?.id
        ? t("chat.commandResults.agents.runtime", { runtime: `\`${agent.agentRuntime.id}\`` })
        : "";
      lines.push(`- \`${agent.id}\` — ${name}${marker}${runtime}`);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return commandFailure("chat.commandResults.agents.failed", err);
  }
}

function resolveSelectedAgentId(
  sessionKey: string,
  context: SlashCommandContext,
): string | undefined {
  const normalizedSessionKey = normalizeOptionalLowercaseString(sessionKey);
  return (
    parseAgentSessionKey(normalizedSessionKey ?? "")?.agentId ??
    normalizeOptionalLowercaseString(context.agentId) ??
    (normalizedSessionKey === DEFAULT_MAIN_KEY
      ? (normalizeOptionalLowercaseString(context.defaultAgentId) ?? DEFAULT_AGENT_ID)
      : undefined)
  );
}

function formatDirectiveOptions(text: string, options: string): string {
  return `${text}\n${t("chat.commandResults.options", { options })}`;
}

async function loadCurrentSessionState(
  context: SlashCommandContext,
  sessionKey: string,
): Promise<{
  session: GatewaySessionRow | undefined;
  defaults: SessionsListResult["defaults"] | undefined;
}> {
  const selectedAgentId = resolveSelectedAgentId(sessionKey, context);
  const { session } = await context.sessions.describe({
    key: sessionKey,
    agentId: selectedAgentId,
  });
  assertCurrentSlashCommand(context);
  const defaultAgentId =
    normalizeOptionalLowercaseString(context.defaultAgentId) ?? DEFAULT_AGENT_ID;
  if (session || (selectedAgentId && selectedAgentId !== defaultAgentId)) {
    return { session: session ?? undefined, defaults: undefined };
  }
  // Before the default agent's first session exists, commands still expose its defaults.
  const listed = await context.sessions.list({ agentId: selectedAgentId, limit: 1 });
  assertCurrentSlashCommand(context);
  if (!listed) {
    throw new Error(t("chat.commandResults.sessionUnavailable"));
  }
  return { session: undefined, defaults: listed.defaults };
}

async function loadModelCommandState(
  client: GatewayBrowserClient,
  context: SlashCommandContext,
  sessionKey: string,
) {
  const modelCatalog = context.chatModelCatalog;
  const agentId = resolveSelectedAgentId(sessionKey, context);
  const [state, models] = await Promise.all([
    loadCurrentSessionState(context, sessionKey),
    modelCatalog
      ? Promise.resolve(modelCatalog)
      : loadModelCatalog(client, { agentId, sessionKey }).then((result) => result.models),
  ]);
  return {
    ...state,
    models,
  };
}

/** Steer keeps the current run; redirect interrupts it and tracks the replacement. */
async function executeRunCommand(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
  command: "steer" | "redirect",
): Promise<SlashCommandResult> {
  try {
    const message = args.trim();
    if (!message) {
      return { content: t(`chat.commandResults.${command}.usage`) };
    }
    assertCurrentSlashCommand(context);
    const response = await client.request<{ runId?: unknown; status?: unknown }>("chat.send", {
      sessionKey,
      ...selectedGlobalScope(sessionKey, context),
      message,
      ...(command === "steer"
        ? { deliver: false, queueMode: "steer" }
        : { queueMode: "interrupt" }),
      idempotencyKey: generateUUID(),
    });
    const ackStatus = normalizeChatSendAckStatus(response?.status);
    if (ackStatus === "timeout" || ackStatus === "error") {
      return {
        content: t(
          `chat.commandResults.${command}.${ackStatus === "timeout" ? "timeout" : "failed"}`,
        ),
        failed: true,
      };
    }
    const result: SlashCommandResult = { content: t(`chat.commandResults.${command}.succeeded`) };
    if (ackStatus === "started" || ackStatus === "in_flight") {
      if (command === "steer") {
        result.pendingCurrentRun = true;
      } else {
        result.trackRunId = typeof response?.runId === "string" ? response.runId : undefined;
      }
    }
    return result;
  } catch (err) {
    return commandFailure(`chat.commandResults.${command}.requestFailed`, err);
  }
}
