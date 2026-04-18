import {
  type PlanRenderFormat,
  type PlanStepForRender,
  renderPlanChecklist,
} from "../../agents/plan-render.js";
/**
 * PR-11: universal `/plan` slash commands for non-webchat channels.
 *
 * Lets any channel (Telegram chat, Discord DM, Signal, iMessage, Slack
 * threads, CLI) drive plan-mode approvals via plain text instead of
 * inline buttons. Subcommands match the webchat chip + approval card
 * affordances:
 *
 *   /plan accept              → planApproval { action: "approve" }
 *   /plan accept edits        → planApproval { action: "edit" }
 *   /plan revise <feedback>   → planApproval { action: "reject", feedback }
 *   /plan auto on|off         → planApproval { action: "auto", autoEnabled }
 *   /plan on|off              → planMode "plan"|"normal" toggle
 *   /plan status              → print current plan-mode state
 *   /plan restate             → re-render the active plan checklist into
 *                               the channel (so the user can see it
 *                               without re-asking the agent)
 *
 * Authorization mirrors `/approve`: requires the sender to be an
 * authorized operator, gates internal-channel callers on
 * operator.approvals scope.
 *
 * Backend call: `sessions.patch` (same RPC the webchat chip + UI use).
 * The gateway-side handler in `src/gateway/sessions-patch.ts` enforces
 * the planMode feature gate + state-machine semantics, so this handler
 * stays a thin parser + dispatcher.
 */
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { logVerbose } from "../../globals.js";
import { resolveApprovalCommandAuthorization } from "../../infra/channel-approval-auth.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveChannelAccountId } from "./channel-context.js";
import { requireGatewayClientScopeForInternalChannel } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const COMMAND_REGEX = /^\/?plan(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/plan@([^\s]+)(?:\s|$)/i;

type PlanSubcommand =
  | { kind: "status" }
  | { kind: "view" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "restate" }
  | { kind: "auto"; autoEnabled: boolean }
  | { kind: "accept"; allowEdits: boolean }
  | { kind: "revise"; feedback: string };

type ParsedPlanCommand = { ok: true; sub: PlanSubcommand } | { ok: false; error: string };

const PLAN_USAGE_TEXT =
  "Usage: /plan <accept|accept edits|revise <feedback>|on|off|status|view|auto on|auto off|restate>";

function parsePlanCommand(raw: string, channel: string): ParsedPlanCommand | null {
  const trimmed = raw.trim();
  // PR-11 review H1: the `/cmd@bot` mention syntax is Telegram-specific.
  // On other channels (Discord/Slack/iMessage/Signal/CLI) `@<word>` after
  // a slash command is just a regular user mention and should not bail
  // the parser. Only enforce the foreign-bot disambiguation on Telegram.
  if (channel.toLowerCase() === "telegram" && FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) {
    return { ok: false, error: "❌ This /plan command targets a different Telegram bot." };
  }
  const commandMatch = trimmed.match(COMMAND_REGEX);
  if (!commandMatch) {
    return null;
  }
  const rest = trimmed.slice(commandMatch[0].length).trim();
  if (!rest) {
    return { ok: true, sub: { kind: "status" } };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  const first = normalizeLowercaseStringOrEmpty(tokens[0] ?? "");
  const second = normalizeLowercaseStringOrEmpty(tokens[1] ?? "");
  const tail = tokens.slice(1).join(" ").trim();

  switch (first) {
    case "status":
      return { ok: true, sub: { kind: "status" } };
    case "view":
      return { ok: true, sub: { kind: "view" } };
    case "on":
      return { ok: true, sub: { kind: "on" } };
    case "off":
      return { ok: true, sub: { kind: "off" } };
    case "restate":
      return { ok: true, sub: { kind: "restate" } };
    case "accept": {
      const allowEdits = second === "edits" || second === "edit";
      return { ok: true, sub: { kind: "accept", allowEdits } };
    }
    case "revise": {
      // /plan revise <feedback>. PR-11 review H2: feedback is REQUIRED.
      // A no-feedback rejection silently increments rejectionCount and
      // can roll the state into a confusing "ask the user to clarify"
      // injection after 3 reflex clicks — UX regression with no
      // operator intent. Force a usage error instead.
      if (!tail) {
        return {
          ok: false,
          error:
            "Usage: /plan revise <feedback> — give the agent something to revise toward, e.g. /plan revise add error handling for the websocket reconnect.",
        };
      }
      return { ok: true, sub: { kind: "revise", feedback: tail } };
    }
    case "auto": {
      // /plan auto [on|off]. Bare /plan auto defaults to on (matches
      // the chip "switch INTO Plan ⚡" intent).
      if (!second || second === "on") {
        return { ok: true, sub: { kind: "auto", autoEnabled: true } };
      }
      if (second === "off") {
        return { ok: true, sub: { kind: "auto", autoEnabled: false } };
      }
      return { ok: false, error: `Unrecognized /plan auto value "${second}". Use on|off.` };
    }
    default:
      return { ok: false, error: PLAN_USAGE_TEXT };
  }
}

function buildResolvedByLabel(params: Parameters<CommandHandler>[0]): string {
  const channel = params.command.channel;
  const sender = params.command.senderId ?? "unknown";
  return `${channel}:${sender}`;
}

// Channels that ONLY accept plaintext (no markdown / HTML rendering).
// Includes SMS-like surfaces, voice surfaces, and chats where markdown
// markers leak as raw text (IRC, line, qqbot, zalo). Sourced from the
// bundled-plugin manifests + extension capability docs.
const PLAINTEXT_ONLY_CHANNELS = new Set([
  "imessage",
  "bluebubbles",
  "sms",
  "signal",
  "irc",
  "nostr",
  "voice-call",
  "voice",
  "line",
  "qqbot",
  "zalo",
  "zalouser",
]);

function pickPlanRenderFormat(channel: string): PlanRenderFormat {
  // Map the channel id to the closest renderer the channel can show
  // natively.
  // - Telegram supports HTML parse_mode.
  // - Slack uses mrkdwn (`*bold*`, `~strike~`).
  // - SMS-like / voice / pre-markdown channels need plaintext (raw `**`
  //   would render literally).
  // - Markdown is the safe default for everything else (Discord,
  //   Matrix, Mattermost, MSTeams, GoogleChat, Feishu, web, cli, etc).
  // Review M4: broaden the plaintext list to cover irc/nostr/voice/line/
  // qqbot/zalo/zalouser per the bundled-plugin channel inventory.
  const lc = channel.toLowerCase();
  if (lc === "telegram") {
    return "html";
  }
  if (lc === "slack") {
    return "slack-mrkdwn";
  }
  if (PLAINTEXT_ONLY_CHANNELS.has(lc)) {
    return "plaintext";
  }
  return "markdown";
}

export const handlePlanCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  const parsed = parsePlanCommand(normalized, params.command.channel);
  if (!parsed) {
    return null;
  }
  if (!parsed.ok) {
    return { shouldContinue: false, reply: { text: parsed.error } };
  }

  // /plan status and /plan view are read-only and safe to expose to any
  // chat participant. /plan restate echoes plan-step text (which can
  // include file paths or sensitive context the agent has seen), so
  // PR-11 review M3: gate it behind the same operator auth as the
  // mutating subcommands. Anyone can ask about state; only operators
  // can pull the actual plan.
  const sub = parsed.sub;
  const isReadOnly = sub.kind === "status" || sub.kind === "view";
  if (!isReadOnly) {
    const effectiveAccountId = resolveChannelAccountId({
      cfg: params.cfg,
      ctx: params.ctx,
      command: params.command,
    });
    const planAuth = resolveApprovalCommandAuthorization({
      cfg: params.cfg,
      channel: params.command.channel,
      accountId: effectiveAccountId,
      senderId: params.command.senderId,
      kind: "plugin",
    });
    const explicitAuth = planAuth.explicit && planAuth.authorized;
    if (!params.command.isAuthorizedSender && !explicitAuth) {
      logVerbose(
        `Ignoring /plan from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const missingScope = requireGatewayClientScopeForInternalChannel(params, {
      label: "/plan",
      allowedScopes: ["operator.approvals", "operator.admin"],
      missingText: "❌ /plan requires operator.approvals for gateway clients.",
    });
    if (missingScope) {
      return missingScope;
    }
  }

  const sessionKey = params.sessionKey;
  const planMode = params.sessionEntry?.planMode;
  const resolvedBy = buildResolvedByLabel(params);

  if (sub.kind === "status") {
    if (!planMode) {
      return {
        shouldContinue: false,
        reply: { text: "Plan mode is **off** for this session." },
      };
    }
    const lines = [
      `Plan mode: **${planMode.mode}**`,
      `Approval: ${planMode.approval}`,
      ...(planMode.autoApprove ? ["Auto-approve: **on**"] : []),
      ...(planMode.rejectionCount && planMode.rejectionCount > 0
        ? [`Rejection cycles: ${planMode.rejectionCount}`]
        : []),
    ];
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (sub.kind === "view") {
    return {
      shouldContinue: false,
      reply: {
        text: "/plan view is only meaningful in the Control UI. Use /plan restate here to re-render the current plan inline.",
      },
    };
  }

  if (sub.kind === "restate") {
    const steps = planMode?.lastPlanSteps;
    if (!steps || steps.length === 0) {
      return {
        shouldContinue: false,
        reply: {
          text: "No active plan to restate — the agent hasn't called update_plan or exit_plan_mode yet.",
        },
      };
    }
    const format = pickPlanRenderFormat(params.command.channel);
    // SessionEntry stores plan steps as the runtime-shape (`status:
    // string`) for forward-compat. The renderer's stricter union type
    // is enforced upstream (lastPlanSteps only ever contains valid
    // PLAN_STEP_STATUSES). Coerce here so the call type-checks; if a
    // future runtime shape diverges, the renderer's switch falls
    // through to the pending case as a defensive default.
    let checklist = renderPlanChecklist(steps as PlanStepForRender[], format);
    // PR-11 deep-dive review M7: cap the rendered checklist below the
    // tightest channel limit (Telegram + WhatsApp = 4096 chars). Long
    // multi-step plans with `acceptanceCriteria` would otherwise be
    // rejected by the channel transport or truncated mid-step.
    // 3500 chars leaves headroom for the title prefix + footer.
    const RESTATE_SOFT_CAP = 3500;
    if (checklist.length > RESTATE_SOFT_CAP) {
      const truncated = checklist.slice(0, RESTATE_SOFT_CAP);
      const remainingSteps = steps.length - (truncated.match(/\n/g)?.length ?? 0) - 1;
      checklist = `${truncated}\n… (${Math.max(remainingSteps, 0)} more line(s) — open the plan-view sidebar in Control UI for the full checklist)`;
    }
    return {
      shouldContinue: false,
      reply: {
        text:
          format === "html"
            ? `<b>Current plan:</b>\n${checklist}`
            : format === "slack-mrkdwn"
              ? `*Current plan:*\n${checklist}`
              : `Current plan:\n${checklist}`,
      },
    };
  }

  // Mutating paths route through sessions.patch (same as the webchat
  // chip + approval card). Errors surface as "Failed to ..." replies.
  const callPatch = async (patch: Record<string, unknown>): Promise<void> => {
    await callGateway({
      method: "sessions.patch",
      params: { key: sessionKey, ...patch },
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Chat /plan (${resolvedBy})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  };

  try {
    if (sub.kind === "on") {
      await callPatch({ planMode: "plan" });
      return {
        shouldContinue: false,
        reply: {
          text: "Plan mode **enabled** — write/edit/exec tools blocked until plan approved.",
        },
      };
    }
    if (sub.kind === "off") {
      await callPatch({ planMode: "normal" });
      return {
        shouldContinue: false,
        reply: { text: "Plan mode **disabled** — mutations unblocked." },
      };
    }
    if (sub.kind === "auto") {
      await callPatch({
        planApproval: { action: "auto", autoEnabled: sub.autoEnabled },
      });
      return {
        shouldContinue: false,
        reply: {
          text: sub.autoEnabled
            ? "Plan auto-approve **enabled** — future plan submissions resolve as approved without confirmation."
            : "Plan auto-approve **disabled** — plan submissions require manual confirmation.",
        },
      };
    }
    if (sub.kind === "accept" || sub.kind === "revise") {
      // PR-11 review M1: pre-check that there's actually a pending
      // approval to act on. Without this, the gateway returns a
      // confusing "stale approvalId" error to the user.
      if (!planMode || planMode.approval !== "pending" || !planMode.approvalId) {
        return {
          shouldContinue: false,
          reply: {
            text:
              "No pending plan to " +
              (sub.kind === "accept" ? "accept" : "revise") +
              " — the agent hasn't submitted a plan via exit_plan_mode yet, or the previous one was already resolved.",
          },
        };
      }
      if (sub.kind === "accept") {
        const action = sub.allowEdits ? "edit" : "approve";
        await callPatch({
          planApproval: { action, approvalId: planMode.approvalId },
        });
        return {
          shouldContinue: false,
          reply: {
            text: sub.allowEdits
              ? "Plan **accepted with edits** — agent may adjust steps as it executes."
              : "Plan **accepted** — agent will execute as proposed.",
          },
        };
      }
      // revise (feedback already validated non-empty at parse time).
      await callPatch({
        planApproval: {
          action: "reject",
          feedback: sub.feedback,
          approvalId: planMode.approvalId,
        },
      });
      // PR-11 deep-dive review M8: neutralize @-mentions when echoing
      // the user-typed feedback back into the channel. A low-privilege
      // operator could otherwise cause the bot to ping @everyone /
      // @here / @channel via the feedback echo (the bot's reply may
      // have different rendering / role permissions than the user's
      // original message).
      const safeEcho = sub.feedback
        .replace(/@(channel|here|everyone)\b/gi, "@\uFE6B$1")
        .replace(/<@/g, "<\u200B@");
      return {
        shouldContinue: false,
        reply: { text: `Plan returned for revision with feedback: "${safeEcho}"` },
      };
    }
  } catch (error) {
    const errMsg = formatErrorMessage(error);
    if (errMsg.includes("plan mode is disabled")) {
      return {
        shouldContinue: false,
        reply: {
          text: "Plan mode is disabled at the config level. Set agents.defaults.planMode.enabled: true and restart the gateway.",
        },
      };
    }
    // PR-11 review L3: map the gateway's "stale approvalId" /
    // "terminal approval state" wording to a friendly chat message.
    // Common case: the user double-clicks /plan accept and the
    // second call lands on an already-resolved approval.
    if (errMsg.includes("stale approvalId") || errMsg.includes("terminal approval state")) {
      return {
        shouldContinue: false,
        reply: {
          text: "Plan was already resolved (likely a duplicate command). Use /plan status to see the current state.",
        },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `❌ Failed to apply /plan command: ${errMsg}` },
    };
  }

  // Unreachable — the switch above covers every PlanSubcommand kind.
  return { shouldContinue: false, reply: { text: PLAN_USAGE_TEXT } };
};
