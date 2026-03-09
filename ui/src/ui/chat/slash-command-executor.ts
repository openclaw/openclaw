/**
 * Client-side execution engine for slash commands.
 * Calls gateway RPC methods and returns formatted results.
 */

import { isSubagentSessionKey, parseAgentSessionKey } from "../../../../src/routing/session-key.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  AgentsListResult,
  GatewaySessionRow,
  HealthSummary,
  ModelCatalogEntry,
  SessionsListResult,
} from "../types.ts";
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
};

export async function executeSlashCommand(
  client: GatewayBrowserClient,
  sessionKey: string,
  commandName: string,
  args: string,
): Promise<SlashCommandResult> {
  switch (commandName) {
    case "help":
      return executeHelp();
    case "status":
      return await executeStatus(client);
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
      return await executeModel(client, sessionKey, args);
    case "think":
      return await executeThink(client, sessionKey, args);
    case "verbose":
      return await executeVerbose(client, sessionKey, args);
    case "export":
      return { content: "Exporting session...", action: "export" };
    case "usage":
      return await executeUsage(client, sessionKey);
    case "agents":
      return await executeAgents(client);
    case "kill":
      return await executeKill(client, sessionKey, args);
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

async function executeStatus(client: GatewayBrowserClient): Promise<SlashCommandResult> {
  try {
    const health = await client.request<HealthSummary>("health", {});
    const status = health.ok ? "Healthy" : "Degraded";
    const agentCount = health.agents?.length ?? 0;
    const sessionCount = health.sessions?.count ?? 0;
    const lines = [
      `**System Status:** ${status}`,
      `**Agents:** ${agentCount}`,
      `**Sessions:** ${sessionCount}`,
      `**Default Agent:** ${health.defaultAgentId || "none"}`,
    ];
    if (health.durationMs) {
      lines.push(`**Response:** ${health.durationMs}ms`);
    }
    return { content: lines.join("\n") };
  } catch (err) {
    return { content: `Failed to fetch status: ${String(err)}` };
  }
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
): Promise<SlashCommandResult> {
  if (!args) {
    try {
      const sessions = await client.request<SessionsListResult>("sessions.list", {});
      const session = sessions?.sessions?.find((s: GatewaySessionRow) => s.key === sessionKey);
      const model = session?.model || sessions?.defaults?.model || "default";
      const models = await client.request<{ models: ModelCatalogEntry[] }>("models.list", {});
      const available = models?.models?.map((m: ModelCatalogEntry) => m.id) ?? [];
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
    await client.request("sessions.patch", { key: sessionKey, model: args.trim() });
    return { content: `Model set to \`${args.trim()}\`.`, action: "refresh" };
  } catch (err) {
    return { content: `Failed to set model: ${String(err)}` };
  }
}

async function executeThink(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
): Promise<SlashCommandResult> {
  const valid = ["off", "low", "medium", "high"];
  const level = args.trim().toLowerCase();

  if (!level) {
    return {
      content: `Usage: \`/think <${valid.join("|")}>\``,
    };
  }
  if (!valid.includes(level)) {
    return {
      content: `Invalid thinking level \`${level}\`. Choose: ${valid.map((v) => `\`${v}\``).join(", ")}`,
    };
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
  const valid = ["on", "off", "full"];
  const level = args.trim().toLowerCase();

  if (!level) {
    return {
      content: `Usage: \`/verbose <${valid.join("|")}>\``,
    };
  }
  if (!valid.includes(level)) {
    return {
      content: `Invalid verbose level \`${level}\`. Choose: ${valid.map((v) => `\`${v}\``).join(", ")}`,
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

async function executeUsage(
  client: GatewayBrowserClient,
  sessionKey: string,
): Promise<SlashCommandResult> {
  try {
    const sessions = await client.request<SessionsListResult>("sessions.list", {});
    const session = sessions?.sessions?.find((s: GatewaySessionRow) => s.key === sessionKey);
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
      matched.map((key) => client.request("chat.abort", { sessionKey: key })),
    );
    const successCount = results.filter((entry) => entry.status === "fulfilled").length;
    if (successCount === 0) {
      const firstFailure = results.find((entry) => entry.status === "rejected");
      throw firstFailure?.reason ?? new Error("abort failed");
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
  const currentParsed = parseAgentSessionKey(currentSessionKey);
  for (const session of sessions) {
    const key = session?.key?.trim();
    if (!key || !isSubagentSessionKey(key)) {
      continue;
    }
    const normalizedKey = key.toLowerCase();
    const parsed = parseAgentSessionKey(normalizedKey);
    const isMatch =
      normalizedTarget === "all" ||
      normalizedKey === normalizedTarget ||
      (parsed?.agentId ?? "") === normalizedTarget ||
      normalizedKey.endsWith(`:subagent:${normalizedTarget}`) ||
      normalizedKey === `subagent:${normalizedTarget}` ||
      (currentParsed?.agentId != null &&
        parsed?.agentId === currentParsed.agentId &&
        normalizedKey.endsWith(`:subagent:${normalizedTarget}`));
    if (isMatch) {
      keys.add(key);
    }
  }
  return [...keys];
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
