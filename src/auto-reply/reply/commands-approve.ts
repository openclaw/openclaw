import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
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

/** Matches the `ID: <uuid>` line in a forwarded approval request message. */
const APPROVAL_ID_RE = /^ID:\s*([0-9a-f-]+)/im;

type ParsedApproveCommand =
  | { ok: true; id: string | null; decision: "allow-once" | "allow-always" | "deny" }
  | { ok: false; error: string };

export function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }
  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: false, error: "Usage: /approve <id> allow-once|allow-always|deny" };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);

  if (tokens.length === 1) {
    const decision = DECISION_ALIASES[tokens[0].toLowerCase()];
    if (decision) {
      return { ok: true, decision, id: null };
    }
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

/**
 * Extract an approval ID from the body of a replied-to approval request message.
 * Returns the ID string or null if not found.
 */
export function extractApprovalIdFromReplyBody(body: string | undefined | null): string | null {
  if (!body) {
    return null;
  }
  const match = APPROVAL_ID_RE.exec(body);
  return match?.[1] ?? null;
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
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  let approvalId = parsed.id;
  if (!approvalId) {
    const extracted = extractApprovalIdFromReplyBody(params.ctx.ReplyToBody);
    if (!extracted) {
      return {
        shouldContinue: false,
        reply: {
          text: "❌ Could not extract approval ID from replied message. Please provide the ID explicitly: /approve <id> allow-once|allow-always|deny",
        },
      };
    }
    approvalId = extracted;
  }

  const missingScope = requireGatewayClientScopeForInternalChannel(params, {
    label: "/approve",
    allowedScopes: ["operator.approvals", "operator.admin"],
    missingText: "❌ /approve requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }

  const resolvedBy = buildResolvedByLabel(params);
  try {
    await callGateway({
      method: "exec.approval.resolve",
      params: { id: approvalId, decision: parsed.decision },
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
    reply: { text: `✅ Exec approval ${parsed.decision} submitted for ${approvalId}.` },
  };
};
