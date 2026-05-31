import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  getChannelPlugin,
  resolveChannelApprovalCapability,
} from "../../channels/plugins/index.js";
import { callGateway } from "../../gateway/call.js";
import { ADMIN_SCOPE, type OperatorScope } from "../../gateway/operator-scopes.js";
import { logVerbose } from "../../globals.js";
import { isApprovalNotFoundError } from "../../infra/approval-errors.js";
import { resolveApprovalOverGateway } from "../../infra/approval-gateway-resolver.js";
import { resolveApprovalCommandAuthorization } from "../../infra/channel-approval-auth.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { resolveChannelAccountId } from "./channel-context.js";
import { requireGatewayClientScope } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/?approve(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/approve@([^\s]+)(?:\s|$)/i;

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

type ApproveDecision = "allow-once" | "allow-always" | "deny";

/** Result of parsing `/approve …`. The id field is a discriminated union:
 *  `implicit` when the user typed a bare `/approve <decision>` (handler
 *  resolves against the single outstanding pending approval — typing a
 *  full uuid by hand on a phone is unrealistic UX), or `explicit` with
 *  the literal id from the message. Modeled this way to avoid a sentinel
 *  string colliding with a real approval id. */
type ParsedApproveCommand =
  | { ok: true; idKind: "explicit"; id: string; decision: ApproveDecision }
  | { ok: true; idKind: "implicit"; decision: ApproveDecision }
  | { ok: false; error: string };

const APPROVE_USAGE_TEXT =
  "Usage: /approve <id> <decision> (see the pending approval message for available decisions)";

function parseApproveCommand(raw: string): ParsedApproveCommand | null {
  const trimmed = raw.trim();
  if (FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return { ok: false, error: "❌ This /approve command targets a different Telegram bot." };
  }
  const commandMatch = trimmed.match(COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const rest = trimmed.slice(commandMatch[0].length).trim();
  if (!rest) {
    return { ok: false, error: APPROVE_USAGE_TEXT };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);

  if (tokens.length === 1) {
    // Bare `/approve <decision>` — resolve against the single most recent
    // pending approval at handler time. Better UX than forcing the user to
    // copy a uuid by hand.
    const only = normalizeLowercaseStringOrEmpty(tokens[0]);
    if (DECISION_ALIASES[only]) {
      return { ok: true, idKind: "implicit", decision: DECISION_ALIASES[only] };
    }
    return { ok: false, error: APPROVE_USAGE_TEXT };
  }

  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  const second = normalizeLowercaseStringOrEmpty(tokens[1]);

  if (DECISION_ALIASES[first]) {
    return {
      ok: true,
      idKind: "explicit",
      decision: DECISION_ALIASES[first],
      id: tokens.slice(1).join(" ").trim(),
    };
  }
  if (DECISION_ALIASES[second]) {
    return {
      ok: true,
      idKind: "explicit",
      decision: DECISION_ALIASES[second],
      id: tokens[0],
    };
  }
  return { ok: false, error: APPROVE_USAGE_TEXT };
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

function formatApprovalSubmitError(error: unknown): string {
  return formatErrorMessage(error);
}

type ApprovalMethod = "exec.approval.resolve" | "plugin.approval.resolve";

function resolveApprovalMethods(params: {
  approvalId: string;
  execAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
  pluginAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
}): ApprovalMethod[] {
  if (params.approvalId.startsWith("plugin:")) {
    return params.pluginAuthorization.authorized ? ["plugin.approval.resolve"] : [];
  }
  if (params.execAuthorization.authorized && params.pluginAuthorization.authorized) {
    return ["exec.approval.resolve", "plugin.approval.resolve"];
  }
  if (params.execAuthorization.authorized) {
    return ["exec.approval.resolve"];
  }
  if (params.pluginAuthorization.authorized) {
    return ["plugin.approval.resolve"];
  }
  return [];
}

function resolveApprovalAuthorizationError(params: {
  approvalId: string;
  execAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
  pluginAuthorization: ReturnType<typeof resolveApprovalCommandAuthorization>;
}): string {
  if (params.approvalId.startsWith("plugin:")) {
    return (
      params.pluginAuthorization.reason ?? "❌ You are not authorized to approve this request."
    );
  }
  return (
    params.execAuthorization.reason ??
    params.pluginAuthorization.reason ??
    "❌ You are not authorized to approve this request."
  );
}

/**
 * Trust property (defence in depth, see PR #78303 review thread):
 * `/approve` commands are only honoured when they come through this
 * handler from the auto-reply command dispatcher, which is invoked
 * exclusively on inbound channel messages with a `senderId` that
 * matches the channel's allowlist (`isAuthorizedSender`). Tool-emitted
 * text and model output never reach this path because they have no
 * verified `senderId`. Bundle-MCP consent envelopes additionally
 * neutralise any `/approve` substring inside tool output before it
 * is rendered into chat — see `sanitiseToolEmittedApprovalText` in
 * `pi-bundle-mcp-consent.ts`. Combined, those two layers prevent a
 * compromised MCP server from self-approving by poisoning the
 * transcript or echoing approval commands through the bot.
 */
export const handleApproveCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  // Authorisation must precede any pending-list queries so unauthorized
  // senders cannot probe approval state or harvest IDs from ambiguity replies.
  const effectiveAccountId = resolveChannelAccountId({
    cfg: params.cfg,
    ctx: params.ctx,
    command: params.command,
  });
  const execApprovalAuthorization = resolveApprovalCommandAuthorization({
    cfg: params.cfg,
    channel: params.command.channel,
    accountId: effectiveAccountId,
    senderId: params.command.senderId,
    kind: "exec",
  });
  const pluginApprovalAuthorization = resolveApprovalCommandAuthorization({
    cfg: params.cfg,
    channel: params.command.channel,
    accountId: effectiveAccountId,
    senderId: params.command.senderId,
    kind: "plugin",
  });
  const hasExplicitApprovalAuthorization =
    (execApprovalAuthorization.explicit && execApprovalAuthorization.authorized) ||
    (pluginApprovalAuthorization.explicit && pluginApprovalAuthorization.authorized);
  if (!params.command.isAuthorizedSender && !hasExplicitApprovalAuthorization) {
    logVerbose(
      `Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const missingScope = requireGatewayClientScope(params, {
    label: "/approve",
    allowedScopes: ["operator.approvals", "operator.admin"],
    missingText: "❌ /approve requires operator.approvals for gateway clients.",
  });
  if (missingScope) {
    return missingScope;
  }

  // If the user typed `/approve <decision>` without an id, resolve to the
  // single most-recent pending approval. Better UX than forcing a
  // copy-paste of a uuid; refuses on ambiguity (multiple pending).
  // Authorization has already been verified above before querying the list.
  //
  // CRITICAL: filter candidates to the initiating approval surface (channel
  // + account) before accepting one. The gateway's list endpoints are
  // visibility-scoped to the backend/device client, NOT to the chat that
  // sent the /approve. Without this filter, an authorized sender in one
  // chat could resolve another chat's pending approval simply because it
  // was the only one visible to the backend client. Requests without a
  // bound turn-source surface (e.g. dashboard-issued approvals) are
  // excluded from implicit-id resolution and require an explicit id.
  type PendingApprovalRecord = {
    id: string;
    request?: {
      turnSourceChannel?: string | null;
      turnSourceAccountId?: string | null;
      turnSourceTo?: string | null;
    } | null;
  };
  let approvalId: string;
  if (parsed.idKind === "implicit") {
    const approvalListScopes: OperatorScope[] = [ADMIN_SCOPE];
    let pendingPlugin: PendingApprovalRecord[];
    try {
      const r = await callGateway<PendingApprovalRecord[]>({
        method: "plugin.approval.list",
        params: {},
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: "Chat approval",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: approvalListScopes,
      });
      pendingPlugin = Array.isArray(r) ? r : [];
    } catch {
      pendingPlugin = [];
    }
    let pendingExec: PendingApprovalRecord[];
    try {
      const r = await callGateway<PendingApprovalRecord[]>({
        method: "exec.approval.list",
        params: {},
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: "Chat approval",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: approvalListScopes,
      });
      pendingExec = Array.isArray(r) ? r : [];
    } catch {
      pendingExec = [];
    }
    const initiatingChannel = normalizeLowercaseStringOrEmpty(params.command.channel);
    const initiatingAccount = normalizeLowercaseStringOrEmpty(effectiveAccountId ?? "");
    const initiatingTo = normalizeLowercaseStringOrEmpty(params.command.to ?? "");
    const matchesInitiatingSurface = (r: PendingApprovalRecord): boolean => {
      const recordChannel = normalizeLowercaseStringOrEmpty(r.request?.turnSourceChannel ?? "");
      const recordAccount = normalizeLowercaseStringOrEmpty(r.request?.turnSourceAccountId ?? "");
      const recordTo = normalizeLowercaseStringOrEmpty(r.request?.turnSourceTo ?? "");
      // Unbound requests (no turn-source-channel) are not eligible for
      // implicit-id resolution from a chat — they must be approved via
      // explicit id to remove cross-surface ambiguity.
      if (!recordChannel) {
        return false;
      }
      if (recordChannel !== initiatingChannel) {
        return false;
      }
      // If the record carries an account binding, it must match the
      // command's account. Records without an account binding are
      // accepted if the channel matches (single-account channels).
      if (recordAccount && initiatingAccount && recordAccount !== initiatingAccount) {
        return false;
      }
      // Scope to the conversation. MCP consent records bind to a
      // turn-source target (the chat that issued the tool call) but carry
      // no account id, so the channel+account checks alone would let a
      // bare `/approve` from a different conversation on the same channel
      // resolve another chat's pending approval. When the record names a
      // target, require it to match the conversation that sent /approve;
      // fail closed (explicit id required) if we cannot confirm the match.
      if (recordTo && recordTo !== initiatingTo) {
        return false;
      }
      return true;
    };
    const candidates = [...pendingPlugin, ...pendingExec]
      .filter((r) => Boolean(r?.id))
      .filter(matchesInitiatingSurface);
    if (candidates.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "❌ No pending approval to act on." },
      };
    }
    if (candidates.length > 1) {
      return {
        shouldContinue: false,
        reply: {
          text:
            `❌ Ambiguous /approve — ${candidates.length} pending approvals. ` +
            `Reply with the explicit id from the approval prompt.`,
        },
      };
    }
    approvalId = candidates[0].id;
  } else {
    approvalId = parsed.id;
  }

  const isPluginId = approvalId.startsWith("plugin:");
  const approvalCapability = resolveChannelApprovalCapability(
    getChannelPlugin(params.command.channel),
  );
  const approveCommandBehavior = approvalCapability?.resolveApproveCommandBehavior?.({
    cfg: params.cfg,
    accountId: effectiveAccountId,
    senderId: params.command.senderId,
    approvalKind: isPluginId ? "plugin" : "exec",
  });
  if (approveCommandBehavior?.kind === "ignore") {
    return { shouldContinue: false };
  }
  if (approveCommandBehavior?.kind === "reply") {
    return { shouldContinue: false, reply: { text: approveCommandBehavior.text } };
  }

  const resolvedBy = buildResolvedByLabel(params);
  const callApprovalMethod = async (method: ApprovalMethod): Promise<void> => {
    await resolveApprovalOverGateway({
      cfg: params.cfg,
      approvalId,
      decision: parsed.decision,
      senderId: params.command.senderId,
      ...(method === "plugin.approval.resolve" ? { resolveMethod: "plugin" as const } : {}),
      clientDisplayName: `Chat approval (${resolvedBy})`,
    });
  };

  const methods = resolveApprovalMethods({
    approvalId,
    execAuthorization: execApprovalAuthorization,
    pluginAuthorization: pluginApprovalAuthorization,
  });
  if (methods.length === 0) {
    return {
      shouldContinue: false,
      reply: {
        text: resolveApprovalAuthorizationError({
          approvalId,
          execAuthorization: execApprovalAuthorization,
          pluginAuthorization: pluginApprovalAuthorization,
        }),
      },
    };
  }

  for (const [index, method] of methods.entries()) {
    try {
      await callApprovalMethod(method);
      break;
    } catch (error) {
      const isLastMethod = index === methods.length - 1;
      if (!isApprovalNotFoundError(error) || isLastMethod) {
        return {
          shouldContinue: false,
          reply: { text: `❌ Failed to submit approval: ${formatApprovalSubmitError(error)}` },
        };
      }
    }
  }

  return {
    shouldContinue: false,
    reply: { text: `✅ Approval ${parsed.decision} submitted for ${approvalId}.` },
  };
};
