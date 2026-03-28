/**
 * Client-side execution engine for slash commands.
 * Calls gateway RPC methods and returns formatted results.
 */

import {
  formatThinkingLevels,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  resolveThinkingDefaultForModel,
} from "../../../../src/auto-reply/thinking.shared.js";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../../../../src/routing/session-key.js";
import { createChatModelOverride, resolvePreferredServerChatModel } from "../chat-model-ref.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentsListResult,
  ChatModelOverride,
  GatewaySessionRow,
  ModelCatalogEntry,
  SessionsListResult,
  SessionsPatchResult,
} from "../types.ts";
import { generateUUID } from "../uuid.ts";
import { SLASH_COMMANDS } from "./slash-commands.ts";

export type SlashCommandResult = {
  /** Markdown-formatted result to display in chat. */
  content: string;
  /** Side-effect action the caller should perform after displaying the result. */
  action?:
    | "refresh"
    | "export"
    | "new-session"
    | "reset"
    | "stop"
    | "clear"
    | "toggle-focus"
    | "navigate-usage";
  /** Optional session-level directive changes that the caller should mirror locally. */
  sessionPatch?: {
    modelOverride?: ChatModelOverride | null;
  };
  /** When set, the caller should track this as the active run (enables Abort, blocks concurrent sends). */
  trackRunId?: string;
};

export type SlashCommandContext = {
  chatModelCatalog?: ModelCatalogEntry[];
  modelCatalog?: ModelCatalogEntry[];
};
export async function executeSlashCommand(
  client: GatewayBrowserClient,
  sessionKey: string,
  commandName: string,
  args: string,
  context: SlashCommandContext = {},
): Promise<SlashCommandResult> {
  switch (commandName) {
    case "help":
      return executeHelp();
    case "new":
      return { content: "Starting new session...", action: "new-session" };
    case "reset":
      return { content: "Resetting session...", action: "reset" };
    case "stop":
      return { content: "Stopping current run...", action: "stop" };
    case "clear":
      return { content: "Chat history cleared.", action: "clear" };
    case "focus":
      return { content: "Toggled focus mode.", action: "toggle-focus" };
    case "compact":
      return await executeCompact(client, sessionKey);
    case "model":
      return await executeModel(client, sessionKey, args, context);
    case "think":
      return await executeThink(client, sessionKey, args);
    case "fast":
      return await executeFast(client, sessionKey, args);
    case "verbose":
      return await executeVerbose(client, sessionKey, args);
    case "export-session":
      return { content: "Exporting session...", action: "export" };
    case "usage":
      return await executeUsage(client, sessionKey);
    case "agents":
      return await executeAgents(client);
    case "kill":
      return await executeKill(client, sessionKey, args);
    case "steer":
      return await executeSteer(client, sessionKey, args);
    case "redirect":
      return await executeRedirect(client, sessionKey, args);
    default:
      return { content: `Unknown command: \`/${commandName}\`` };
  }
}

// ── Command Implementations ──

function executeHelp(): SlashCommandResult {
  const lines = ["**Available Commands**\n"];
  let currentCategory = "";

  for (const cmd of SLASH_COMMANDS) {
    const cat = cmd.category ?? "session";
    if (cat !== currentCategory) {
      currentCategory = cat;
      lines.push(`**${cat.charAt(0).toUpperCase() + cat.slice(1)}**`);
    }
    const argStr = cmd.args ? ` ${cmd.args}` : "";
    const local = cmd.executeLocal ? "" : " *(agent)*";
    lines.push(`\`/${cmd.name}${argStr}\` — ${cmd.description}${local}`);
  }

  lines.push("\nType `/` to open the command menu.");
  return { content: lines.join("\n") };
}

async function executeCompact(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    await client.request("sessions.compact", { key: sessionKey });
    return { content: "Context compacted successfully.", action: "refresh" };
  } catch (err) {
    return { content: `Compaction failed: ${String(err)}` };
  }
}

async function executeModel(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const modelCatalog = context.chatModelCatalog ?? context.modelCatalog;
  if (!args) {
    try {
      const [sessions, models] = await Promise.all([
        client.request<SessionsListResult>("sessions.list", {}),
        modelCatalog ? Promise.resolve(modelCatalog) : loadModelCatalog(client),
      ]);
      const session = resolveCurrentSession(sessions, sessionKey);
      const model = session?.model || sessions?.defaults?.model || "default";
      const available = models.map((m: ModelCatalogEntry) => m.id);
      const lines = [`**Current model:** \`${model}\``];
      if (available.length > 0) {
        lines.push(
          `**Available:** ${available
            .slice(0, 10)
            .map((m: string) => `\`${m}\``)
            .join(", ")}${available.length > 10 ? ` +${available.length - 10} more` : ""}`,
        );
      }
      return { content: lines.join("\n") };
    } catch (err) {
      return { content: `Failed to get model info: ${String(err)}` };
    }
  }

  try {
    const [patched, resolvedModelCatalog] = await Promise.all([
      client.request<SessionsPatchResult>("sessions.patch", {
        key: sessionKey,
        model: args.trim(),
      }),
      modelCatalog
        ? Promise.resolve(modelCatalog)
        : loadModelCatalog(client, { allowFailure: true }),
    ]);
    const resolvedValue = resolvePreferredServerChatModel(
      patched.resolved?.model ?? args.trim(),
      patched.resolved?.modelProvider,
      resolvedModelCatalog,
    ).value;
    return {
      content: `Model set to \`${args.trim()}\`.`,
      action: "refresh",
      sessionPatch: { modelOverride: createChatModelOverride(resolvedValue) },
    };
  } catch (err) {
    return { content: `Failed to set model: ${String(err)}` };
  }
}

async function executeThink(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const { session, models } = await loadThinkingCommandState(client, sessionKey);
      return {
        content: formatDirectiveOptions(
          `Current thinking level: ${resolveCurrentThinkingLevel(session, models)}.`,
          formatThinkingLevels(session?.modelProvider, session?.model),
        ),
      };
    } catch (err) {
      return { content: `Failed to get thinking level: ${String(err)}` };
    }
  }

  const level = normalizeThinkLevel(rawLevel);
  if (!level) {
    try {
      const session = await loadCurrentSession(client, sessionKey);
      return {
        content: `Unrecognized thinking level "${rawLevel}". Valid levels: ${formatThinkingLevels(session?.modelProvider, session?.model)}.`,
      };
    } catch (err) {
      return { content: `Failed to validate thinking level: ${String(err)}` };
    }
  }

  try {
    await client.request("sessions.patch", { key: sessionKey, thinkingLevel: level });
    return {
      content: `Thinking level set to **${level}**.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set thinking level: ${String(err)}` };
  }
}

async function executeVerbose(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawLevel = args.trim();

  if (!rawLevel) {
    try {
      const session = await loadCurrentSession(client, sessionKey);
      return {
        content: formatDirectiveOptions(
          `Current verbose level: ${normalizeVerboseLevel(session?.verboseLevel) ?? "off"}.`,
          "on, full, off",
        ),
      };
    } catch (err) {
      return { content: `Failed to get verbose level: ${String(err)}` };
    }
  }

  const level = normalizeVerboseLevel(rawLevel);
  if (!level) {
    return {
      content: `Unrecognized verbose level "${rawLevel}". Valid levels: off, on, full.`,
    };
  }

  try {
    await client.request("sessions.patch", { key: sessionKey, verboseLevel: level });
    return {
      content: `Verbose mode set to **${level}**.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set verbose mode: ${String(err)}` };
  }
}

async function executeFast(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const rawMode = args.trim().toLowerCase();

  if (!rawMode || rawMode === "status") {
    try {
      const session = await loadCurrentSession(client, sessionKey);
      return {
        content: formatDirectiveOptions(
          `Current fast mode: ${resolveCurrentFastMode(session)}.`,
          "status, on, off",
        ),
      };
    } catch (err) {
      return { content: `Failed to get fast mode: ${String(err)}` };
    }
  }

  if (rawMode !== "on" && rawMode !== "off") {
    return {
      content: `Unrecognized fast mode "${args.trim()}". Valid levels: status, on, off.`,
    };
  }

  try {
    await client.request("sessions.patch", { key: sessionKey, fastMode: rawMode === "on" });
    return {
      content: `Fast mode ${rawMode === "on" ? "enabled" : "disabled"}.`,
      action: "refresh",
    };
  } catch (err) {
    return { content: `Failed to set fast mode: ${String(err)}` };
  }
}

async function executeUsage(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    const sessions = await client.request<SessionsListResult>("sessions.list", {});
    const session = resolveCurrentSession(sessions, sessionKey);
    if (!session) {
      return { content: "No active session." };
    }
    const input = session.inputTokens ?? 0;
    const output = session.outputTokens ?? 0;
    const total = session.totalTokens ?? input + output;
    const ctx = session.contextTokens ?? 0;
    const pct = ctx > 0 ? Math.round((input / ctx) * 100) : null;

    const lines = [
      "**Session Usage**",
      `Input: **${fmtTokens(input)}** tokens`,
      `Output: **${fmtTokens(output)}** tokens`,
      `Total: **${fmtTokens(total)}** tokens`,
    ];
    if (pct !== null) {
      lines.push(`Context: **${pct}%** of ${fmtTokens(ctx)}`);
    }
    if (session.model) {
      lines.push(`Model: \`${session.model}\``);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to get usage: ${String(err)}` };
  }
}

async function executeAgents(client: GatewayBrowserClient): Promise<SlashCommandResult> {
  try {
    const result = await client.request<AgentsListResult>("agents.list", {});
    const agents = result?.agents ?? [];
    if (agents.length === 0) {
      return { content: "No agents configured." };
    }
    const lines = [`**Agents** (${agents.length})\n`];
    for (const agent of agents) {
      const isDefault = agent.id === result?.defaultId;
      const name = agent.identity?.name || agent.name || agent.id;
      const marker = isDefault ? " *(default)*" : "";
      lines.push(`- \`${agent.id}\` — ${name}${marker}`);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to list agents: ${String(err)}` };
  }
}

async function executeKill(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const target = args.trim();
  if (!target) {
    return { content: "Usage: `/kill <id|all>`" };
  }
  try {
    const sessions = await client.request<SessionsListResult>("sessions.list", {});
    const matched = resolveKillTargets(sessions?.sessions ?? [], sessionKey, target);
    if (matched.length === 0) {
      return {
        content:
          target.toLowerCase() === "all"
            ? "No active sub-agent sessions found."
            : `No matching sub-agent sessions found for \`${target}\`.`,
      };
    }

    const results = await Promise.allSettled(
      matched.map((key) =>
        client.request<{ aborted?: boolean }>("chat.abort", { sessionKey: key }),
      ),
    );
    const rejected = results.filter((entry) => entry.status === "rejected");
    const successCount = results.filter(
      (entry) =>
        entry.status === "fulfilled" && (entry.value as { aborted?: boolean })?.aborted !== false,
    ).length;
    if (successCount === 0) {
      if (rejected.length === 0) {
        return {
          content:
            target.toLowerCase() === "all"
              ? "No active sub-agent runs to abort."
              : `No active runs matched \`${target}\`.`,
        };
      }
      throw rejected[0]?.reason ?? new Error("abort failed");
    }

    if (target.toLowerCase() === "all") {
      return {
        content:
          successCount === matched.length
            ? `Aborted ${successCount} sub-agent session${successCount === 1 ? "" : "s"}.`
            : `Aborted ${successCount} of ${matched.length} sub-agent sessions.`,
      };
    }

    return {
      content:
        successCount === matched.length
          ? `Aborted ${successCount} matching sub-agent session${successCount === 1 ? "" : "s"} for \`${target}\`.`
          : `Aborted ${successCount} of ${matched.length} matching sub-agent sessions for \`${target}\`.`,
    };
  } catch (err) {
    return { content: `Failed to abort: ${String(err)}` };
  }
}

function resolveKillTargets(
  sessions: GatewaySessionRow[],
  currentSessionKey: string,
  target: string,
): string[] {
  const normalizedTarget = target.trim().toLowerCase();
  if (!normalizedTarget) {
    return [];
  }

  const keys = new Set<string>();
  const normalizedCurrentSessionKey = currentSessionKey.trim().toLowerCase();
  const currentParsed = parseAgentSessionKey(normalizedCurrentSessionKey);
  const currentAgentId =
    currentParsed?.agentId ??
    (normalizedCurrentSessionKey === DEFAULT_MAIN_KEY ? DEFAULT_AGENT_ID : undefined);
  const sessionIndex = buildSessionIndex(sessions);
  for (const session of sessions) {
    const key = session?.key?.trim();
    if (!key || !isSubagentSessionKey(key)) {
      continue;
    }
    const normalizedKey = key.toLowerCase();
    const parsed = parseAgentSessionKey(normalizedKey);
    const belongsToCurrentSession = isWithinCurrentSessionSubtree(
      normalizedKey,
      normalizedCurrentSessionKey,
      sessionIndex,
      currentAgentId,
      parsed?.agentId,
    );
    const isMatch =
      (normalizedTarget === "all" && belongsToCurrentSession) ||
      (belongsToCurrentSession && normalizedKey === normalizedTarget) ||
      (belongsToCurrentSession &&
        ((parsed?.agentId ?? "") === normalizedTarget ||
          normalizedKey.endsWith(`:subagent:${normalizedTarget}`) ||
          normalizedKey === `subagent:${normalizedTarget}`));
    if (isMatch) {
      keys.add(key);
    }
  }
  return [...keys];
}

function isWithinCurrentSessionSubtree(
  candidateSessionKey: string,
  currentSessionKey: string,
  sessionIndex: Map<string, GatewaySessionRow>,
  currentAgentId: string | undefined,
  candidateAgentId: string | undefined,
): boolean {
  if (!currentAgentId || candidateAgentId !== currentAgentId) {
    return false;
  }

  const currentAliases = resolveEquivalentSessionKeys(currentSessionKey, currentAgentId);
  const seen = new Set<string>();
  let parentSessionKey = normalizeSessionKey(sessionIndex.get(candidateSessionKey)?.spawnedBy);
  while (parentSessionKey && !seen.has(parentSessionKey)) {
    if (currentAliases.has(parentSessionKey)) {
      return true;
    }
    seen.add(parentSessionKey);
    parentSessionKey = normalizeSessionKey(sessionIndex.get(parentSessionKey)?.spawnedBy);
  }

  // Older gateways may not include spawnedBy on session rows yet; keep prefix
  // matching for nested subagent sessions as a compatibility fallback.
  return isSubagentSessionKey(currentSessionKey)
    ? candidateSessionKey.startsWith(`${currentSessionKey}:subagent:`)
    : false;
}

function buildSessionIndex(sessions: GatewaySessionRow[]): Map<string, GatewaySessionRow> {
  const index = new Map<string, GatewaySessionRow>();
  for (const session of sessions) {
    const normalizedKey = normalizeSessionKey(session?.key);
    if (!normalizedKey) {
      continue;
    }
    index.set(normalizedKey, session);
  }
  return index;
}

function normalizeSessionKey(key?: string | null): string | undefined {
  const normalized = key?.trim().toLowerCase();
  return normalized || undefined;
}

function resolveEquivalentSessionKeys(
  currentSessionKey: string,
  currentAgentId: string | undefined,
): Set<string> {
  const keys = new Set<string>([currentSessionKey]);
  if (currentAgentId === DEFAULT_AGENT_ID) {
    const canonicalDefaultMain = `agent:${DEFAULT_AGENT_ID}:main`;
    if (currentSessionKey === DEFAULT_MAIN_KEY) {
      keys.add(canonicalDefaultMain);
    } else if (currentSessionKey === canonicalDefaultMain) {
      keys.add(DEFAULT_MAIN_KEY);
    }
  }
  return keys;
}

function formatDirectiveOptions(text: string, options: string): string {
  return `${text}\nOptions: ${options}.`;
}

async function loadCurrentSession(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<GatewaySessionRow | undefined> {
  const sessions = await client.request<SessionsListResult>("sessions.list", {});
  return resolveCurrentSession(sessions, sessionKey);
}

function resolveCurrentSession(
  sessions: SessionsListResult | undefined,
  sessionKey: string,
): GatewaySessionRow | undefined {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const currentAgentId =
    parseAgentSessionKey(normalizedSessionKey ?? "")?.agentId ??
    (normalizedSessionKey === DEFAULT_MAIN_KEY ? DEFAULT_AGENT_ID : undefined);
  const aliases = normalizedSessionKey
    ? resolveEquivalentSessionKeys(normalizedSessionKey, currentAgentId)
    : new Set<string>();
  return sessions?.sessions?.find((session: GatewaySessionRow) => {
    const key = normalizeSessionKey(session.key);
    return key ? aliases.has(key) : false;
  });
}

async function loadThinkingCommandState(client: GatewayBrowserClient, sessionKey: string) {
  const [sessions, models] = await Promise.all([
    client.request<SessionsListResult>("sessions.list", {}),
    loadModelCatalog(client),
  ]);
  return {
    session: resolveCurrentSession(sessions, sessionKey),
    models,
  };
}

async function loadModelCatalog(
  client: GatewayBrowserClient,
  opts?: { allowFailure?: boolean },
): Promise<ModelCatalogEntry[]> {
  try {
    const result = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {});
    return result?.models ?? [];
  } catch (err) {
    if (opts?.allowFailure) {
      return [];
    }
    throw err;
  }
}

function resolveCurrentThinkingLevel(
  session: GatewaySessionRow | undefined,
  models: ModelCatalogEntry[],
): string {
  const persisted = normalizeThinkLevel(session?.thinkingLevel);
  if (persisted) {
    return persisted;
  }
  if (!session?.modelProvider || !session.model) {
    return "off";
  }
  return resolveThinkingDefaultForModel({
    provider: session.modelProvider,
    model: session.model,
    catalog: models,
  });
}

function resolveCurrentFastMode(session: GatewaySessionRow | undefined): "on" | "off" {
  return session?.fastMode === true ? "on" : "off";
}

/**
 * Match a target name against active subagent sessions by key/label only.
 * Unlike resolveKillTargets, this does NOT match by agent id (avoiding
 * false positives for common words like "main") and filters to active
 * sessions (no endedAt) so stale subagents are not targeted.
 */
function resolveSteerSubagent(
  sessions: GatewaySessionRow[],
  currentSessionKey: string,
  target: string,
): string[] {
  const normalizedTarget = target.trim().toLowerCase();
  if (!normalizedTarget) {
    return [];
  }
  const normalizedCurrentSessionKey = currentSessionKey.trim().toLowerCase();
  const currentParsed = parseAgentSessionKey(normalizedCurrentSessionKey);
  const currentAgentId =
    currentParsed?.agentId ??
    (normalizedCurrentSessionKey === DEFAULT_MAIN_KEY ? DEFAULT_AGENT_ID : undefined);
  const sessionIndex = buildSessionIndex(sessions);

  const keys = new Set<string>();
  for (const session of sessions) {
    const key = session?.key?.trim();
    if (!key || !isSubagentSessionKey(key)) {
      continue;
    }
    // P1: skip ended sessions so stale subagents are not targeted
    if (session.endedAt) {
      continue;
    }
    const normalizedKey = key.toLowerCase();
    const parsed = parseAgentSessionKey(normalizedKey);
    const belongsToCurrentSession = isWithinCurrentSessionSubtree(
      normalizedKey,
      normalizedCurrentSessionKey,
      sessionIndex,
      currentAgentId,
      parsed?.agentId,
    );
    if (!belongsToCurrentSession) {
      continue;
    }
    // P2: match only on subagent key suffix or label, not agent id
    const isMatch =
      normalizedKey.endsWith(`:subagent:${normalizedTarget}`) ||
      normalizedKey === `subagent:${normalizedTarget}` ||
      (session.label ?? "").toLowerCase() === normalizedTarget;
    if (isMatch) {
      keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Resolve an optional subagent target from the first word of args.
 * Returns the resolved session key and the remaining message, or
 * falls back to the current session key with the full args as message.
 */
async function resolveSteerTarget(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<{ key: string; message: string; label?: string } | { error: string }> {
  const trimmed = args.trim();
  if (!trimmed) {
    return { error: "empty" };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0) {
    const maybeTarget = trimmed.slice(0, spaceIdx);
    const rest = trimmed.slice(spaceIdx + 1).trim();
    // Skip "all" — resolveKillTargets treats it as a wildcard, but steer/redirect
    // target a single session, so "all good now" should not match subagents.
    if (rest && maybeTarget.toLowerCase() !== "all") {
      const sessions = await client.request<SessionsListResult>("sessions.list", {});
      const matched = resolveSteerSubagent(sessions?.sessions ?? [], sessionKey, maybeTarget);
      if (matched.length === 1) {
        return { key: matched[0], message: rest, label: maybeTarget };
      }
      if (matched.length > 1) {
        return { error: `Multiple sub-agents match \`${maybeTarget}\`. Be more specific.` };
      }
    }
  }
  return { key: sessionKey, message: trimmed };
}

/** Soft inject — queues a message into the active run via chat.send (deliver: false). */
async function executeSteer(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  try {
    const resolved = await resolveSteerTarget(client, sessionKey, args);
    if ("error" in resolved) {
      return {
        content: resolved.error === "empty" ? "Usage: `/steer [id] <message>`" : resolved.error,
      };
    }
    await client.request("chat.send", {
      sessionKey: resolved.key,
      message: resolved.message,
      deliver: false,
      idempotencyKey: generateUUID(),
    });
    return { content: resolved.label ? `Steered \`${resolved.label}\`.` : "Steered." };
  } catch (err) {
    return { content: `Failed to steer: ${String(err)}` };
  }
}

/** Hard redirect — aborts the active run and restarts with a new message. */
async function executeRedirect(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  try {
    const resolved = await resolveSteerTarget(client, sessionKey, args);
    if ("error" in resolved) {
      return {
        content: resolved.error === "empty" ? "Usage: `/redirect [id] <message>`" : resolved.error,
      };
    }
    const resp = await client.request<{ runId?: string }>("sessions.steer", {
      key: resolved.key,
      message: resolved.message,
    });
    // Only track the run when redirecting the current session. Subagent
    // redirects target a different sessionKey, so chat events for that run
    // would never clear chatRunId on the current view.
    const runId = typeof resp?.runId === "string" ? resp.runId : undefined;
    const trackRunId = resolved.key === sessionKey ? runId : undefined;
    return {
      content: resolved.label ? `Redirected \`${resolved.label}\`.` : "Redirected.",
      trackRunId,
    };
  } catch (err) {
    return { content: `Failed to redirect: ${String(err)}` };
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}
