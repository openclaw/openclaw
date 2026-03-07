import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  listKnowledgeTransferRules,
  removeKnowledgeTransferRule,
  resolveKnowledgeTransferDefaults,
  setKnowledgeTransferPairMode,
  upsertKnowledgeTransferRule,
  type KnowledgeTransferMode,
  type KnowledgeTransferRuleDecision,
  type KnowledgeTransferSide,
} from "../../infra/knowledge-transfer-policy.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND = "/learn";

type PairTarget = { requesterAgentId: string; targetAgentId: string };

type ParsedLearnCommand =
  | { ok: true; action: "approve"; id: string }
  | { ok: true; action: "deny"; id: string }
  | { ok: true; action: "mode"; mode: KnowledgeTransferMode; pair: PairTarget }
  | {
      ok: true;
      action: "rule_add";
      pair: PairTarget;
      side: KnowledgeTransferSide;
      decision: KnowledgeTransferRuleDecision;
      pathPattern: string;
    }
  | { ok: true; action: "rule_remove"; id: string; pair?: PairTarget }
  | { ok: true; action: "rule_list"; pair?: PairTarget }
  | { ok: true; action: "status"; pair?: PairTarget }
  | { ok: false; error: string }
  | null;

function usage(): string {
  return [
    "Usage:",
    "/learn approve <id>",
    "/learn deny <id>",
    "/learn mode ask|auto [--pair <requester,target>]",
    "/learn rule add <hide|ask|auto> --side <export|import> --path <glob> [--pair <requester,target>]",
    "/learn rule remove <id> [--pair <requester,target>]",
    "/learn rule list [--pair <requester,target>]",
    "/learn status [--pair <requester,target>]",
  ].join("\n");
}

function parsePairValue(raw: string): PairTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(",");
  if (parts.length !== 2) {
    return null;
  }
  const requesterAgentId = parts[0]?.trim() ?? "";
  const targetAgentId = parts[1]?.trim() ?? "";
  if (!requesterAgentId || !targetAgentId) {
    return null;
  }
  return { requesterAgentId, targetAgentId };
}

function parseOptionalPair(tokens: string[]):
  | {
      ok: true;
      pair?: PairTarget;
    }
  | {
      ok: false;
      error: string;
    } {
  if (tokens.length === 0) {
    return { ok: true, pair: undefined };
  }

  let pairValue: string | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const lowered = token.toLowerCase();
    if (lowered === "--pair") {
      pairValue = tokens[i + 1];
      break;
    }
    if (lowered.startsWith("--pair=")) {
      pairValue = token.slice("--pair=".length);
      break;
    }
  }

  if (pairValue == null) {
    return { ok: true, pair: undefined };
  }

  const pair = parsePairValue(pairValue);
  if (!pair) {
    return { ok: false, error: `${usage()}\n\nInvalid --pair value. Use requester,target.` };
  }

  return { ok: true, pair };
}

function parseMode(value: string | undefined): KnowledgeTransferMode | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "ask" || normalized === "auto") {
    return normalized;
  }
  return null;
}

function parseRuleDecision(value: string | undefined): KnowledgeTransferRuleDecision | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "ask" || normalized === "auto" || normalized === "hide") {
    return normalized;
  }
  return null;
}

function parseRuleSide(value: string | undefined): KnowledgeTransferSide | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "export" || normalized === "import") {
    return normalized;
  }
  return null;
}

function readOptionValue(tokens: string[], name: string): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    const lowered = token.toLowerCase();
    if (lowered === `--${name}`) {
      return tokens[i + 1];
    }
    if (lowered.startsWith(`--${name}=`)) {
      return token.slice(name.length + 3);
    }
  }
  return undefined;
}

function parseLearnCommand(raw: string): ParsedLearnCommand {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(COMMAND)) {
    return null;
  }

  const rest = trimmed.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: false, error: usage() };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = tokens[0]?.toLowerCase();
  if (action === "approve" || action === "deny") {
    const id = tokens.slice(1).join(" ").trim();
    if (!id) {
      return { ok: false, error: usage() };
    }
    return { ok: true, action, id };
  }

  if (action === "mode") {
    const mode = parseMode(tokens[1]);
    if (!mode) {
      return { ok: false, error: usage() };
    }
    const pairResult = parseOptionalPair(tokens.slice(2));
    if (!pairResult.ok) {
      return pairResult;
    }
    return {
      ok: true,
      action: "mode",
      mode,
      pair: pairResult.pair ?? { requesterAgentId: "*", targetAgentId: "*" },
    };
  }

  if (action === "rule") {
    const subAction = tokens[1]?.toLowerCase();
    if (subAction === "add") {
      const decision =
        parseRuleDecision(tokens[2]) ?? parseRuleDecision(readOptionValue(tokens, "decision"));
      const side = parseRuleSide(readOptionValue(tokens, "side"));
      const pathPattern = readOptionValue(tokens, "path")?.trim();
      const pairResult = parseOptionalPair(tokens.slice(2));
      if (!pairResult.ok) {
        return pairResult;
      }
      if (!decision || !side || !pathPattern) {
        return { ok: false, error: usage() };
      }
      return {
        ok: true,
        action: "rule_add",
        pair: pairResult.pair ?? { requesterAgentId: "*", targetAgentId: "*" },
        side,
        decision,
        pathPattern,
      };
    }

    if (subAction === "remove") {
      const id = (tokens[2] ?? "").trim();
      if (!id) {
        return { ok: false, error: usage() };
      }
      const pairResult = parseOptionalPair(tokens.slice(3));
      if (!pairResult.ok) {
        return pairResult;
      }
      return {
        ok: true,
        action: "rule_remove",
        id,
        pair: pairResult.pair,
      };
    }

    if (subAction === "list") {
      const pairResult = parseOptionalPair(tokens.slice(2));
      if (!pairResult.ok) {
        return pairResult;
      }
      return {
        ok: true,
        action: "rule_list",
        pair: pairResult.pair,
      };
    }

    return { ok: false, error: usage() };
  }

  if (action === "status") {
    const pairResult = parseOptionalPair(tokens.slice(1));
    if (!pairResult.ok) {
      return pairResult;
    }
    return {
      ok: true,
      action: "status",
      pair: pairResult.pair,
    };
  }

  return { ok: false, error: usage() };
}

function pairLabel(pair: PairTarget): string {
  return `${pair.requesterAgentId},${pair.targetAgentId}`;
}

function requiresOwner(action: ParsedLearnCommand & { ok: true }): boolean {
  return (
    action.action === "approve" ||
    action.action === "deny" ||
    action.action === "mode" ||
    action.action === "rule_add" ||
    action.action === "rule_remove"
  );
}

function resolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

function hasGatewayApprovalsScope(scopes: string[]): boolean {
  return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
}

export const handleLearnCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const parsed = parseLearnCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /learn from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  if (requiresOwner(parsed) && !params.command.senderIsOwner) {
    return {
      shouldContinue: false,
      reply: { text: "❌ /learn approve|deny|mode|rule add|rule remove requires an owner sender." },
    };
  }

  if (isInternalMessageChannel(params.command.channel) && requiresOwner(parsed)) {
    const scopes = params.ctx.GatewayClientScopes ?? [];
    if (!hasGatewayApprovalsScope(scopes)) {
      return {
        shouldContinue: false,
        reply: {
          text: "❌ /learn owner actions require operator.approvals for gateway clients.",
        },
      };
    }
  }

  if (parsed.action === "approve" || parsed.action === "deny") {
    const decision = parsed.action === "approve" ? "allow" : "deny";
    try {
      await callGateway({
        method: "knowledge.transfer.approval.resolve",
        params: { id: parsed.id, decision },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: `Knowledge transfer approval (${resolvedByLabel(params)})`,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
    } catch (err) {
      return {
        shouldContinue: false,
        reply: {
          text: `❌ Failed to submit knowledge transfer decision: ${String(err)}`,
        },
      };
    }

    return {
      shouldContinue: false,
      reply: {
        text: `✅ Knowledge transfer ${decision} submitted for ${parsed.id}.`,
      },
    };
  }

  if (parsed.action === "mode") {
    await setKnowledgeTransferPairMode({
      requesterAgentId: parsed.pair.requesterAgentId,
      targetAgentId: parsed.pair.targetAgentId,
      mode: parsed.mode,
    });
    return {
      shouldContinue: false,
      reply: {
        text: `✅ Learn mode set to ${parsed.mode} for pair ${pairLabel(parsed.pair)} (export+import, path=*).`,
      },
    };
  }

  if (parsed.action === "rule_add") {
    const result = await upsertKnowledgeTransferRule({
      requesterAgentId: parsed.pair.requesterAgentId,
      targetAgentId: parsed.pair.targetAgentId,
      side: parsed.side,
      pathPattern: parsed.pathPattern,
      decision: parsed.decision,
    });
    return {
      shouldContinue: false,
      reply: {
        text: `✅ Rule saved: id=${result.rule.id} pair=${pairLabel(parsed.pair)} side=${parsed.side} decision=${parsed.decision} path=${result.rule.pathPattern}`,
      },
    };
  }

  if (parsed.action === "rule_remove") {
    const removed = await removeKnowledgeTransferRule({
      id: parsed.id,
      requesterAgentId: parsed.pair?.requesterAgentId,
      targetAgentId: parsed.pair?.targetAgentId,
    });
    if (!removed.removed) {
      return {
        shouldContinue: false,
        reply: { text: `❌ No rule found for id=${parsed.id}.` },
      };
    }
    const pairText = removed.pair
      ? `${removed.pair.requesterAgentId},${removed.pair.targetAgentId}`
      : "unknown";
    return {
      shouldContinue: false,
      reply: { text: `✅ Removed rule ${parsed.id} from pair ${pairText}.` },
    };
  }

  const cfg = loadConfig();
  const defaults = resolveKnowledgeTransferDefaults(cfg);

  if (parsed.action === "rule_list" || parsed.action === "status") {
    const rules = await listKnowledgeTransferRules({
      requesterAgentId: parsed.pair?.requesterAgentId,
      targetAgentId: parsed.pair?.targetAgentId,
    });

    const lines = [
      parsed.action === "status" ? "🧠 Learn status" : "🧠 Learn rules",
      `Enabled: ${defaults.enabled ? "yes" : "no"}`,
      `Default Export Mode: ${defaults.defaultExportMode}`,
      `Default Import Mode: ${defaults.defaultImportMode}`,
      `Approval Timeout: ${defaults.approvalTimeoutSeconds}s`,
      ...(parsed.pair ? [`Pair: ${pairLabel(parsed.pair)}`] : []),
      `Rules: ${rules.length}`,
    ];

    for (const rule of rules.slice(0, 30)) {
      lines.push(
        `- ${rule.id} | ${rule.requesterAgentId},${rule.targetAgentId} | ${rule.side} | ${rule.decision} | ${rule.pathPattern}`,
      );
    }
    if (rules.length > 30) {
      lines.push(`- ... ${rules.length - 30} more`);
    }

    return {
      shouldContinue: false,
      reply: { text: lines.join("\n") },
    };
  }

  return {
    shouldContinue: false,
    reply: { text: usage() },
  };
};
