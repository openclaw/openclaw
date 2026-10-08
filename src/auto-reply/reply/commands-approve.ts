import { expectDefined } from "@openclaw/normalization-core";
// Implements approval commands for pending exec, plugin, and OpenClaw change requests.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  getChannelPlugin,
  resolveChannelApprovalCapability,
} from "../../channels/plugins/index.js";
import { logVerbose } from "../../globals.js";
import { isApprovalNotFoundError } from "../../infra/approval-errors.js";
import {
  isPendingSystemAgentApprovalOverGateway,
  resolveApprovalOverGateway,
} from "../../infra/approval-gateway-resolver.js";
import type { ChannelApprovalKind } from "../../infra/approval-types.js";
import {
  resolveApprovalCommandAuthorization,
  type ApprovalCommandAuthorization,
} from "../../infra/channel-approval-auth.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveChannelAccountId } from "./channel-context.js";
import { commandReply, requireGatewayClientScope } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const log = createSubsystemLogger("auto-reply/commands-approve");

const COMMAND_REGEX = /^\/?approve(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/approve@([^\s]+)(?:\s|$)/i;

const DECISION_ALIASES = new Map<string, "allow-once" | "allow-always" | "deny">([
  ["allow", "allow-once"],
  ["once", "allow-once"],
  ["allow-once", "allow-once"],
  ["allowonce", "allow-once"],
  ["always", "allow-always"],
  ["allow-always", "allow-always"],
  ["allowalways", "allow-always"],
  ["deny", "deny"],
  ["reject", "deny"],
  ["block", "deny"],
]);

type ParsedApproveCommand =
  | { ok: true; id: string; decision: "allow-once" | "allow-always" | "deny" }
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
  const tokens = rest.split(/\s+/);
  if (tokens.length < 2) {
    return { ok: false, error: APPROVE_USAGE_TEXT };
  }

  const first = normalizeLowercaseStringOrEmpty(tokens[0]);
  const second = normalizeLowercaseStringOrEmpty(tokens[1]);

  const firstDecision = DECISION_ALIASES.get(first);
  if (firstDecision) {
    return {
      ok: true,
      decision: firstDecision,
      id: tokens.slice(1).join(" "),
    };
  }
  const secondDecision = DECISION_ALIASES.get(second);
  if (secondDecision) {
    return {
      ok: true,
      decision: secondDecision,
      id: expectDefined(tokens[0], "tokens entry at 0"),
    };
  }
  return { ok: false, error: APPROVE_USAGE_TEXT };
}

type ApproveCommandParams = Pick<Parameters<CommandHandler>[0], "cfg" | "command" | "ctx">;

type ApproveCommandBehavior =
  | { kind: "allow" }
  | { kind: "ignore" }
  | { kind: "reply"; text: string };

export async function handleApproveCommandFromContext(
  params: ApproveCommandParams,
  allowTextCommands: boolean,
) {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parseApproveCommand(normalized);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return commandReply(parsed.error);
  }

  const effectiveAccountId = resolveChannelAccountId({
    cfg: params.cfg,
    ctx: params.ctx,
    command: params.command,
  });
  const approvalCapability = resolveChannelApprovalCapability(
    getChannelPlugin(params.command.channel),
  );
  const pluginReviewerSenderId =
    approvalCapability?.resolveReviewerSenderId?.({
      cfg: params.cfg,
      accountId: effectiveAccountId,
      senderId: params.command.senderId,
      spaceId: params.ctx.GroupSpace,
    }) ?? params.command.senderId;
  // Probe order: legacy exec/plugin resolution reports not-found for other
  // owners; system-agent resolution reads the owner first (see below).
  const approvalKinds = ["exec", "plugin", "system-agent"] as const;
  const authorize = (kind: ChannelApprovalKind) =>
    resolveApprovalCommandAuthorization({
      cfg: params.cfg,
      channel: params.command.channel,
      accountId: effectiveAccountId,
      senderId: kind === "plugin" ? pluginReviewerSenderId : params.command.senderId,
      kind,
    });
  const authorizations: Record<(typeof approvalKinds)[number], ApprovalCommandAuthorization> = {
    exec: authorize("exec"),
    plugin: authorize("plugin"),
    "system-agent": authorize("system-agent"),
  };
  const hasExplicitApprovalAuthorization = Object.values(authorizations).some(
    (authorization) => authorization.explicit && authorization.authorized,
  );
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

  // Channels with reviewer custody let the Gateway judge the actor; elsewhere an
  // OpenClaw change needs the current configured owner, like the tool that proposed it.
  const systemAgentNeedsOwner = !approvalCapability?.authorizeActorAction;
  const commandBehaviors = new Map<ChannelApprovalKind, ApproveCommandBehavior | undefined>();
  for (const approvalKind of approvalKinds) {
    commandBehaviors.set(
      approvalKind,
      approvalCapability?.resolveApproveCommandBehavior?.({
        cfg: params.cfg,
        accountId: effectiveAccountId,
        senderId: params.command.senderId,
        approvalKind,
      }),
    );
  }
  const blockedCommandResult = (): Awaited<ReturnType<CommandHandler>> => {
    const replyBehavior = Array.from(commandBehaviors.values()).find(
      (behavior) => behavior?.kind === "reply",
    );
    if (replyBehavior?.kind === "reply") {
      return commandReply(replyBehavior.text);
    }
    if (Array.from(commandBehaviors.values()).some((behavior) => behavior?.kind === "ignore")) {
      return { shouldContinue: false };
    }
    return null;
  };

  const resolvedBy = `${params.command.channel}:${params.command.senderId ?? "unknown"}`;
  const callApprovalMethod = async (approvalKind: ChannelApprovalKind): Promise<void> => {
    // Channel senders deciding an OpenClaw change carry their identity so the
    // Gateway's final decision guard rechecks live custody (channel approvers,
    // or else configured owner). Gateway clients are authorized by their scopes.
    const reviewer =
      approvalCapability?.authorizeActorAction ||
      (approvalKind === "system-agent" && !Array.isArray(params.ctx.GatewayClientScopes))
        ? {
            channel: params.command.channel,
            accountId: effectiveAccountId,
            senderId: approvalKind === "plugin" ? pluginReviewerSenderId : params.command.senderId,
          }
        : {};
    const clientDisplayName = `Chat approval (${resolvedBy})`;
    if (approvalKind === "system-agent") {
      // Canonical resolution denies an approval addressed with the wrong owner,
      // so confirm the owner before submitting the decision.
      const isSystemAgentApproval = await isPendingSystemAgentApprovalOverGateway({
        cfg: params.cfg,
        approvalId: parsed.id,
        clientDisplayName,
      });
      if (!isSystemAgentApproval) {
        throw new Error("unknown or expired approval id");
      }
      if (systemAgentNeedsOwner) {
        try {
          params.command.assertOwnerCurrent?.();
        } catch {
          throw new Error("your owner authority changed; send /approve again");
        }
      }
    }
    const request = {
      cfg: params.cfg,
      approvalId: parsed.id,
      decision: parsed.decision,
      ...reviewer,
      clientDisplayName,
    };
    await (approvalKind === "system-agent"
      ? resolveApprovalOverGateway({ ...request, approvalKind })
      : resolveApprovalOverGateway({ ...request, resolveMethod: approvalKind }));
  };

  const systemAgentRefusedForOwner =
    systemAgentNeedsOwner &&
    !params.command.senderIsOwner &&
    authorizations["system-agent"].authorized;
  const ownerOnlyResult = commandReply(
    "❌ Only the owner can approve OpenClaw changes in this chat.",
  );
  const methods = approvalKinds.filter((approvalKind) => {
    if (approvalKind === "system-agent" && systemAgentRefusedForOwner) {
      return false;
    }
    const behavior = commandBehaviors.get(approvalKind);
    return authorizations[approvalKind].authorized && (!behavior || behavior.kind === "allow");
  });
  if (methods.length === 0) {
    const blocked = blockedCommandResult();
    if (blocked) {
      return blocked;
    }
    if (systemAgentRefusedForOwner) {
      return ownerOnlyResult;
    }
    return commandReply(
      Object.values(authorizations).find((authorization) => authorization.reason)?.reason ??
        "❌ You are not authorized to approve this request.",
    );
  }

  for (const [index, method] of methods.entries()) {
    try {
      await callApprovalMethod(method);
      break;
    } catch (error) {
      if (isApprovalNotFoundError(error)) {
        if (index < methods.length - 1) {
          continue;
        }
        const blocked = blockedCommandResult();
        if (blocked) {
          return blocked;
        }
        // Not an exec or plugin approval; it may be a change only the owner can decide.
        if (systemAgentRefusedForOwner) {
          return ownerOnlyResult;
        }
        return commandReply(
          "That approval is no longer available. Check the request in the Control UI.",
        );
      }
      log.warn(`Approval submission failed: ${formatErrorMessage(error)}`);
      return commandReply(
        "⚠️ Couldn't confirm that approval. Check the request in the Control UI before trying again.",
      );
    }
  }

  return commandReply(`✅ Approval ${parsed.decision} submitted for ${parsed.id}.`);
}
