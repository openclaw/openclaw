import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND = "/approve";

const DECISION_ALIASES: Record<string, "allow-once" | "allow-always" | "deny"> = {
  allow: "allow-once",
  once: "allow-once",
  "allow-once": "allow-once",
  allowonce: "allow-once",
  always: "allow-always",
  "allow-always": "allow-always",
  allowalways: "allow-always",
  deny: "deny",
  reject: "deny",
  block: "deny",
};

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }

  const first = tokens[0].toLowerCase();
  const second = tokens[1].toLowerCase();

  if (DECISION_ALIASES[first]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      ok: true,
      decision: DECISION_ALIASES[second],
      id: tokens[0],
    };
  }
  return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
}

function isApproveCommand(raw: string): boolean {
  return raw.trim().toLowerCase().startsWith(COMMAND);
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;

  // First gate: check if this is actually an /approve command
  if (!isApproveCommand(normalized)) {
    return null;
  }

  // Now check authorization - only after confirming it's an approve command
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Try to parse from CommandArgs first (new format with named args)
  const commandArgs = params.ctx.CommandArgs;
  let id: string | undefined;
  let decision: "allow-once" | "allow-always" | "deny" | undefined;

  if (commandArgs?.values) {
    // New format: /approve <id> <decision> with named args
    id = commandArgs.values.id?.trim();
    const rawDecision = commandArgs.values.decision?.trim().toLowerCase();
    if (rawDecision) {
      decision = DECISION_ALIASES[rawDecision];
    }
  }

  // Fall back to legacy positional parsing only if needed
  if (!id || !decision) {
    const parsed = parseApproveCommand(normalized);
    if (parsed) {
      // Only use legacy values if they provide missing data
      if (!id && parsed.ok) {
        id = parsed.id;
      }
      if (!decision && parsed.ok) {
        decision = parsed.decision;
      }
      if (!parsed.ok) {
        return { shouldContinue: false, reply: { text: parsed.error } };
      }
    }
  }

  if (!id || !decision) {
    return {
      shouldContinue: false,
      reply: { text: "Usage: /approve <id> allow-once|allow-always|deny" },
    };
  }

  if (isInternalMessageChannel(params.command.channel)) {
    const scopes = params.ctx.GatewayClientScopes ?? [];
    const hasApprovals = scopes.includes("operator.approvals") || scopes.includes("operator.admin");
    if (!hasApprovals) {
      logVerbose("Ignoring /approve from gateway client missing operator.approvals.");
      return {
        shouldContinue: false,
        reply: {
          text: "❌ /approve requires operator.approvals for gateway clients.",
        },
      };
    }
  }

  const resolvedBy = buildResolvedByLabel(params);
  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id, decision },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat approval (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  } catch (err) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Failed to submit approval: ${String(err)}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Exec approval ${decision} submitted for ${id}.` },
  };
};
