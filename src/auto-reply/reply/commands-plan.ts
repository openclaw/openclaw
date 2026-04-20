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
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
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
  | { kind: "revise"; feedback: string }
  | { kind: "answer"; answer: string };

type ParsedPlanCommand = { ok: true; sub: PlanSubcommand } | { ok: false; error: string };

const PLAN_USAGE_TEXT =
  "Usage: /plan <accept|accept edits|revise <feedback>|answer <text>|on|off|status|view|auto on|auto off|restate>";

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

  // Codex review #68939 (2026-04-20): reject trailing tokens on
  // single-token commands so typos like `/plan off later` don't
  // silently execute the mode change. `normalizeLowercaseStringOrEmpty`
  // returns `""` (never undefined) when a token is absent, so the
  // precise "no extra arg" predicate is `tokens.length === 1`.
  const rejectTrailingTokens = (verb: string) =>
    tokens.length > 1
      ? ({
          ok: false,
          error: `Usage: /plan ${verb} — unexpected trailing argument "${tokens.slice(1).join(" ")}". This command takes no arguments.`,
        } as const)
      : null;

  switch (first) {
    case "status": {
      const err = rejectTrailingTokens("status");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "status" } };
    }
    case "view": {
      const err = rejectTrailingTokens("view");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "view" } };
    }
    case "on": {
      const err = rejectTrailingTokens("on");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "on" } };
    }
    case "off": {
      const err = rejectTrailingTokens("off");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "off" } };
    }
    case "restate": {
      const err = rejectTrailingTokens("restate");
      if (err) {
        return err;
      }
      return { ok: true, sub: { kind: "restate" } };
    }
    case "accept": {
      // Codex review #68939 (2026-04-20): `normalizeLowercaseStringOrEmpty`
      // returns `""` (never undefined) when `tokens[1]` is absent, so
      // the prior check `second !== undefined && ...` ALWAYS fired and
      // rejected the documented bare `/plan accept` form. Treat empty
      // string the same as missing.
      const isBareAccept = second === "";
      const isEditsAccept = second === "edits" || second === "edit";
      if (!isBareAccept && !isEditsAccept) {
        return {
          ok: false,
          error: `Usage: /plan accept [edits] — unknown argument "${second}". Valid forms: /plan accept, /plan accept edits.`,
        };
      }
      // Reject trailing tokens beyond the `edits` / `edit` qualifier so
      // `/plan accept edits now` doesn't silently approve.
      const maxTokens = isEditsAccept ? 2 : 1;
      if (tokens.length > maxTokens) {
        return {
          ok: false,
          error: `Usage: /plan accept [edits] — unexpected trailing argument "${tokens.slice(maxTokens).join(" ")}".`,
        };
      }
      const allowEdits = isEditsAccept;
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
    case "answer": {
      // PR-11 review fix (Codex P1 #3105075577): text-channel users
      // need a way to answer ask_user_question prompts since the
      // approval card with inline option buttons only renders in
      // webchat (and Telegram via the markdown-attachment path,
      // which doesn't include buttons). Routes to
      // sessions.patch { planApproval: { action: "answer", answer }}.
      if (!tail) {
        return {
          ok: false,
          error:
            "Usage: /plan answer <text> — answer the agent's ask_user_question prompt. The text becomes the chosen option (or a free-text response if the agent allowed it).",
        };
      }
      return { ok: true, sub: { kind: "answer", answer: tail } };
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

function pickPlanRenderFormat(channel: string): PlanRenderFormat {
  // Map the channel id to the closest renderer the channel can show
  // natively.
  // - Telegram supports HTML parse_mode.
  // - Slack uses mrkdwn (`*bold*`, `~strike~`).
  // - All other channels: consult the channel-meta registry's
  //   `markdownCapable` flag (PR-11 review fix Codex P2 #3104742929).
  //   Markdown-capable channels (Discord, Matrix, Mattermost, MSTeams,
  //   GoogleChat, Feishu, web, CLI, WhatsApp, etc) get markdown.
  //   Channels that declare `markdownCapable: false` (SMS-like, voice,
  //   pre-markdown surfaces) get plaintext so raw `**bold**` doesn't
  //   leak as literal text. This delegates to the same registry that
  //   `isMarkdownCapableMessageChannel` uses elsewhere — no separate
  //   hardcoded list to drift out of sync.
  const lc = channel.toLowerCase();
  if (lc === "telegram") {
    return "html";
  }
  if (lc === "slack") {
    return "slack-mrkdwn";
  }
  // Lazy-load the registry helper to keep this module's eager
  // dependencies minimal (the helper pulls in the channel registry
  // which has its own startup cost).
  if (!isMarkdownCapableMessageChannel(lc)) {
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
  const pendingInteraction = params.sessionEntry?.pendingInteraction;
  const pendingQuestionApprovalId =
    pendingInteraction?.kind === "question"
      ? pendingInteraction.approvalId
      : params.sessionEntry?.pendingQuestionApprovalId;
  const pendingQuestionId =
    pendingInteraction?.kind === "question" ? pendingInteraction.questionId : undefined;
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
    //
    // PR-11 review fix (Codex P1 #3104742928): truncate the STEPS
    // array first, then render. Pre-fix the truncation sliced the
    // rendered string at an arbitrary char boundary, which on
    // Telegram (HTML format) could cut through `<b>...</b>` /
    // `<s>...</s>` tags and produce malformed parse_mode content
    // that Telegram rejects entirely. Step-aware truncation keeps
    // each rendered line whole.
    const RESTATE_SOFT_CAP = 3500;
    let renderedSteps = steps as PlanStepForRender[];
    let droppedCount = 0;
    let checklist = renderPlanChecklist(renderedSteps, format);
    while (checklist.length > RESTATE_SOFT_CAP && renderedSteps.length > 1) {
      droppedCount += 1;
      renderedSteps = renderedSteps.slice(0, -1);
      checklist = renderPlanChecklist(renderedSteps, format);
    }
    // PR-11 review fix (Codex P2 #3105247855): the loop above only drops
    // trailing steps while >1 remain, so a single oversized step (or one
    // step with very long acceptanceCriteria) can still exceed the cap
    // and produce a payload Telegram or other channel rejects. When down
    // to 1 step still over cap, truncate that step's text in-place and
    // re-render so the formatting (HTML tags, markdown checkboxes) stays
    // valid — the renderer rewraps it cleanly.
    if (checklist.length > RESTATE_SOFT_CAP && renderedSteps.length === 1) {
      const TRUNCATED_STEP_MAX = Math.max(200, RESTATE_SOFT_CAP - 200);
      const original = renderedSteps[0];
      const truncatedStep: PlanStepForRender = {
        ...original,
        step:
          original.step.length > TRUNCATED_STEP_MAX
            ? original.step.slice(0, TRUNCATED_STEP_MAX) + "…"
            : original.step,
        ...(original.activeForm
          ? {
              activeForm:
                original.activeForm.length > 200
                  ? original.activeForm.slice(0, 200) + "…"
                  : original.activeForm,
            }
          : {}),
        // Drop acceptanceCriteria/verifiedCriteria when truncating —
        // keeping partial criteria is misleading, and the user can
        // open Control UI sidebar for the full plan.
        ...(original.acceptanceCriteria ? { acceptanceCriteria: undefined } : {}),
        ...(original.verifiedCriteria ? { verifiedCriteria: undefined } : {}),
      };
      renderedSteps = [truncatedStep];
      checklist = renderPlanChecklist(renderedSteps, format);
      droppedCount += 1; // count the in-place truncation in the footer note
    }
    if (droppedCount > 0) {
      const footerNote = `\n… (${droppedCount} more step(s) truncated — open the plan-view sidebar in Control UI for the full checklist)`;
      checklist = `${checklist}${footerNote}`;
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
    if (sub.kind === "answer") {
      // PR-11 review fix (Codex P1 #3105075577): /plan answer routes
      // through the same sessions.patch action="answer" path as the
      // webchat question card. The runtime injects the synthetic
      // [QUESTION_ANSWER]: user message at next-turn start (via
      // pendingAgentInjection — see plan-snapshot-persister.ts +
      // pi-embedded-runner pendingInjection consumer).
      //
      // Codex P1 review #68939 (2026-04-19): thread the
      // `pendingQuestionApprovalId` from the session entry into the
      // patch payload. The gateway-side answer-guard requires it;
      // without it, the patch fails with "no pending question".
      // The schema also now requires `approvalId` on the answer
      // variant (third-wave discriminated-union refactor).
      if (!pendingQuestionApprovalId) {
        return {
          shouldContinue: false,
          reply: {
            text: "No pending ask_user_question for this session — `/plan answer` requires a question to be active.",
          },
        };
      }
      await callPatch({
        planApproval: {
          action: "answer",
          answer: sub.answer,
          approvalId: pendingQuestionApprovalId,
          ...(pendingQuestionId ? { questionId: pendingQuestionId } : {}),
        },
      });
      // Codex P1 review #68939 (2026-04-19): set `shouldContinue:
      // true` so the agent-runner pipeline runs the agent after the
      // patch lands. Pre-fix, the handler returned `shouldContinue:
      // false` with a confirmation reply — but the
      // [QUESTION_ANSWER] synthetic injection only fires at next
      // turn-start, so the agent stayed idle until an unrelated
      // later message or heartbeat. Now the agent resumes
      // immediately and the user sees the agent's first response
      // as the implicit "answer received" confirmation.
      return { shouldContinue: true };
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
        // Codex P1 review #68939 (2026-04-19): set
        // `shouldContinue: true` so the agent-runner pipeline
        // resumes the agent immediately after the approval lands.
        // Pre-fix, the handler returned `shouldContinue: false` —
        // the plan decision was stored in `pendingAgentInjection`
        // but only consumed at next turn-start, so non-web channels
        // reported "agent will execute" while the agent stayed
        // idle until an unrelated later message or heartbeat. Now
        // the agent resumes immediately and the user sees its
        // first action as the implicit "approval received" signal.
        return { shouldContinue: true };
      }
      // revise (feedback already validated non-empty at parse time).
      await callPatch({
        planApproval: {
          action: "reject",
          feedback: sub.feedback,
          approvalId: planMode.approvalId,
        },
      });
      // Codex P1 review #68939 (2026-04-19): same `shouldContinue:
      // true` as accept — the rejection injection ([PLAN_DECISION]:
      // rejected with feedback) is in `pendingAgentInjection` and
      // the agent needs to run to consume it and revise the plan.
      // Pre-fix, the agent stayed idle after the user's feedback
      // landed, defeating the revise-and-resubmit loop on text
      // channels.
      return { shouldContinue: true };
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
    if (errMsg.includes("PLAN_APPROVAL_GATE_STATE_UNAVAILABLE")) {
      return {
        shouldContinue: false,
        reply: {
          text: "Refresh the session or ask the agent to resubmit the plan before approving again. The runtime could not safely reconstruct the subagent gate state for this plan cycle.",
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
