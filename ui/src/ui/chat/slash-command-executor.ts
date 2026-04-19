/**
 * Client-side execution engine for slash commands.
 * Calls gateway RPC methods and returns formatted results.
 */

import {
  createChatModelOverride,
  resolvePreferredServerChatModelValue,
} from "../chat-model-ref.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../session-key.ts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../string-coerce.ts";
import {
  formatThinkingLevels,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} from "../thinking.ts";
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
    | "toggle-plan-view"
    | "navigate-usage";
  /** Optional session-level directive changes that the caller should mirror locally. */
  sessionPatch?: {
    modelOverride?: ChatModelOverride | null;
  };
  /** When set, the caller should track this as the active run (enables Abort, blocks concurrent sends). */
  trackRunId?: string;
  /** When set, the caller should surface a visible pending item tied to the current run. */
  pendingCurrentRun?: boolean;
  /**
   * When true, the caller should trigger the hidden plan-resume path
   * after the patch lands. The authoritative decision/answer context
   * already lives in the gateway-owned pending injection queue; the
   * resume call only wakes the next turn without echoing synthetic
   * control text into visible chat history.
   */
  resumePlanInteraction?: boolean;
};

export type SlashCommandContext = {
  chatModelCatalog?: ModelCatalogEntry[];
  modelCatalog?: ModelCatalogEntry[];
  sessionsResult?: SessionsListResult | null;
};

function normalizeVerboseLevel(raw?: string | null): "off" | "on" | "full" | undefined {
  if (!raw) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(raw);
  if (["off", "false", "no", "0"].includes(key)) {
    return "off";
  }
  if (["full", "all", "everything"].includes(key)) {
    return "full";
  }
  if (["on", "minimal", "true", "yes", "1"].includes(key)) {
    return "on";
  }
  return undefined;
}

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
      return await executeSteer(client, sessionKey, args, context);
    case "redirect":
      return await executeRedirect(client, sessionKey, args, context);
    case "plan":
      return await executePlan(client, sessionKey, args, context);
    default:
      return { content: `Unknown command: \`/${commandName}\`` };
  }
}

/**
 * `/plan on|off|status|view|auto [on|off]` — manage plan-mode session state.
 *
 * - `on` / `off`: toggle planMode via `setSessionPlanMode`
 * - `view`: UI-only sidebar toggle (no gateway round-trip)
 * - `status`: print usage / discoverability helper
 * - `auto on|off`: PR-10 — toggle the session's autoApprove flag via
 *   `sessions.patch { planApproval: { action: "auto", autoEnabled }}`.
 *   When ON, future `exit_plan_mode` submissions auto-resolve as
 *   "approve" without user confirmation (Cloud Code parity for
 *   long-running unattended sessions).
 *
 * All paths are validated against the gateway's
 * `agents.defaults.planMode.enabled` opt-in gate.
 */
/**
 * PR-11 review: shared error mapper for the universal /plan
 * subcommands. Maps gateway errors to friendly chat messages.
 */
function mapPlanCommandError(err: unknown, verb: string): SlashCommandResult {
  const msg = String(err);
  if (msg.includes("plan mode is disabled")) {
    return {
      content:
        "Plan mode is disabled at the config level. Set `agents.defaults.planMode.enabled: true` and restart the gateway.",
    };
  }
  if (msg.includes("stale approvalId") || msg.includes("terminal approval state")) {
    return {
      content:
        "Plan was already resolved (likely a duplicate command). Use `/plan status` to see the current state.",
    };
  }
  if (msg.includes("requires an active plan-mode session")) {
    return {
      content: `No pending plan to ${verb} — the agent hasn't submitted a plan via exit_plan_mode yet, or the previous one was already resolved.`,
    };
  }
  if (msg.includes("PLAN_APPROVAL_GATE_STATE_UNAVAILABLE")) {
    return {
      content:
        "Plan approval could not be resumed safely because the subagent gate state was lost. Refresh the session or ask the agent to resubmit the plan.",
    };
  }
  return { content: `Failed to ${verb}: ${msg}` };
}

/**
 * Codex P1 review #68939 (2026-04-19): look up the live `approvalId`
 * for a session from the cached `sessionsResult` snapshot so the
 * webchat /plan accept|revise|answer paths can include it in the
 * `sessions.patch` call. Pre-fix, the webchat patches omitted
 * `approvalId` entirely — letting a stale `/plan accept` typed AFTER
 * the previous plan was resolved silently approve a freshly-submitted
 * one (race window between approval landing and the next plan
 * submission). Mirrors the backend `commands-plan.ts` handler which
 * always threads `planMode.approvalId` (see line 431/447 in that file).
 *
 * Returns `undefined` when no live planMode is cached or when no
 * pending approval exists. The gateway-side handler still validates
 * `approvalId` server-side; passing `undefined` preserves the prior
 * looser behavior so this fix is non-breaking when the snapshot is
 * stale or absent.
 */
function resolvePendingApprovalIdFromContext(
  sessionKey: string,
  context: SlashCommandContext,
): string | undefined {
  const rows = context.sessionsResult?.sessions;
  if (!Array.isArray(rows)) {
    return undefined;
  }
  for (const row of rows) {
    if (row?.key === sessionKey) {
      const pm = row.planMode;
      if (pm && pm.approval === "pending" && typeof pm.approvalId === "string" && pm.approvalId) {
        return pm.approvalId;
      }
      return undefined;
    }
  }
  return undefined;
}

/**
 * Codex P2 review #68939 (2026-04-19): the question approval is a
 * separate id namespace from the plan approval. Pre-fix, the webchat
 * `/plan answer` path called `resolvePendingApprovalIdFromContext`
 * which only returns `planMode.approvalId` (the PLAN id) — the
 * gateway-side answer-guard validates against
 * `pendingQuestionApprovalId` (the QUESTION id) and would reject
 * the patch as a stale token. New helper reads the question-specific
 * id from the cached session row (now exposed via
 * `GatewaySessionRow.pendingQuestionApprovalId` per the third-wave
 * companion change in `session-utils.ts`).
 *
 * Returns `undefined` when no question is pending; caller surfaces
 * a friendly "no pending question" message in that case.
 */
function resolvePendingQuestionFromContext(
  sessionKey: string,
  context: SlashCommandContext,
): { approvalId?: string; questionId?: string } {
  const rows = context.sessionsResult?.sessions;
  if (!Array.isArray(rows)) {
    return {};
  }
  for (const row of rows) {
    if (row?.key === sessionKey) {
      if (row.pendingInteraction?.kind === "question") {
        return {
          approvalId: row.pendingInteraction.approvalId,
          questionId: row.pendingInteraction.questionId,
        };
      }
      const id = row.pendingQuestionApprovalId;
      if (typeof id === "string" && id) {
        return { approvalId: id };
      }
      return {};
    }
  }
  return {};
}

async function executePlan(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  const raw = normalizeLowercaseStringOrEmpty(args);
  // PR-8 follow-up: `/plan view` is a UI-only toggle that opens the
  // plan-view sidebar with the most recent live plan (or a placeholder
  // when none has been emitted yet). Mirrors the chat-controls Plan
  // view button — handled by the host via the `toggle-plan-view`
  // action; no gateway round-trip.
  if (raw === "view") {
    return {
      content: "Toggling plan view sidebar.",
      action: "toggle-plan-view",
    };
  }
  // PR-10: `/plan auto on|off` toggles autoApprove. Without an
  // explicit on/off arg, defaults to on (matches the chip's "switch
  // INTO Plan ⚡" intent).
  if (raw === "auto" || raw.startsWith("auto ")) {
    const tail = raw.slice(4).trim();
    let autoEnabled: boolean;
    if (!tail || tail === "on") {
      autoEnabled = true;
    } else if (tail === "off") {
      autoEnabled = false;
    } else {
      return {
        content: `Unrecognized auto value "${tail}". Valid: on, off.`,
      };
    }
    try {
      await setSessionPlanAutoApprove(client, sessionKey, autoEnabled);
      return {
        content: autoEnabled
          ? "Plan auto-approve **enabled** — future plan submissions resolve as approved without confirmation."
          : "Plan auto-approve **disabled** — plan submissions require manual confirmation.",
        action: "refresh",
      };
    } catch (err) {
      const msg = String(err);
      if (msg.includes("plan mode is disabled")) {
        return {
          content:
            "Plan mode is disabled at the config level. Set `agents.defaults.planMode.enabled: true` and restart the gateway.",
        };
      }
      return { content: `Failed to set plan auto-approve: ${msg}` };
    }
  }
  // PR-11 review fix (Copilot #3105169610): the universal /plan
  // subcommands (accept | accept edits | revise <feedback> | restate |
  // answer <text>) were intercepted by the local executor's old
  // "on/off/status/view/auto only" gate and rejected before reaching
  // the backend handler. Route them to the same sessions.patch shapes
  // that backend `commands-plan.ts` uses so webchat has parity with
  // every other channel (Telegram/Discord/Slack/etc).
  if (raw === "accept" || raw.startsWith("accept ")) {
    const allowEdits = raw === "accept edits" || raw === "accept edit";
    const approvalId = resolvePendingApprovalIdFromContext(sessionKey, context);
    try {
      await client.request("sessions.patch", {
        key: sessionKey,
        planApproval: {
          action: allowEdits ? "edit" : "approve",
          ...(approvalId ? { approvalId } : {}),
        },
      });
      return {
        content: allowEdits
          ? "Plan **accepted with edits** — agent may adjust steps as it executes."
          : "Plan **accepted** — agent will execute as proposed.",
        action: "refresh",
        resumePlanInteraction: true,
      };
    } catch (err) {
      return mapPlanCommandError(err, "accept");
    }
  }
  if (raw === "revise" || raw.startsWith("revise ")) {
    const feedback = args.trim().slice(6).trim();
    if (!feedback) {
      return {
        content:
          "Usage: `/plan revise <feedback>` — give the agent something to revise toward, e.g. `/plan revise add error handling for the websocket reconnect`.",
      };
    }
    const approvalId = resolvePendingApprovalIdFromContext(sessionKey, context);
    try {
      await client.request("sessions.patch", {
        key: sessionKey,
        planApproval: { action: "reject", feedback, ...(approvalId ? { approvalId } : {}) },
      });
      return {
        content: `Plan returned for revision with feedback: "${feedback}"`,
        action: "refresh",
        resumePlanInteraction: true,
      };
    } catch (err) {
      return mapPlanCommandError(err, "revise");
    }
  }
  if (raw === "answer" || raw.startsWith("answer ")) {
    const answer = args.trim().slice(6).trim();
    if (!answer) {
      return {
        content: "Usage: `/plan answer <text>` — answer the agent's `ask_user_question` prompt.",
      };
    }
    // Codex P2 review #68939 (2026-04-19): use the
    // QUESTION-specific approvalId, not the plan approvalId. The
    // gateway-side answer-guard validates against
    // `pendingQuestionApprovalId` (a separate token namespace from
    // `planMode.approvalId`); pre-fix, the webchat `/plan answer`
    // path threaded the plan id and the patch was rejected as a
    // stale token.
    const pendingQuestion = resolvePendingQuestionFromContext(sessionKey, context);
    const questionApprovalId = pendingQuestion.approvalId;
    if (!questionApprovalId) {
      return {
        content:
          "No pending `ask_user_question` for this session — `/plan answer` requires an active question.",
      };
    }
    try {
      await client.request("sessions.patch", {
        key: sessionKey,
        planApproval: {
          action: "answer",
          answer,
          approvalId: questionApprovalId,
          ...(pendingQuestion.questionId ? { questionId: pendingQuestion.questionId } : {}),
        },
      });
      return {
        content: `Question answered: "${answer}"`,
        action: "refresh",
        resumePlanInteraction: true,
      };
    } catch (err) {
      return mapPlanCommandError(err, "answer");
    }
  }
  if (raw === "restate") {
    // Webchat already shows the live plan in the sidebar; redirect to
    // /plan view rather than duplicating the rendered plan in chat.
    return {
      content:
        "On webchat, use `/plan view` (or click the Plan view button in the chat controls) to see the active plan in the sidebar.",
      action: "toggle-plan-view",
    };
  }

  if (!raw || raw === "status") {
    return {
      content: formatDirectiveOptions(
        "Usage: `/plan on` to enter plan mode, `/plan off` to exit, `/plan view` to toggle the sidebar, `/plan auto on|off` to toggle auto-approve, `/plan accept`/`/plan accept edits`/`/plan revise <feedback>`/`/plan answer <text>` to resolve.",
        "on, off, status, view, auto, accept, revise, answer",
      ),
    };
  }
  if (raw !== "on" && raw !== "off") {
    return {
      content: `Unrecognized plan-mode value "${args.trim()}". Valid: on, off, status, view, auto, accept, revise, answer.`,
    };
  }
  const mode: "plan" | "normal" = raw === "on" ? "plan" : "normal";
  try {
    await setSessionPlanMode(client, sessionKey, mode);
    return {
      content:
        mode === "plan"
          ? "Plan mode **enabled** — write/edit/exec tools blocked until plan approved."
          : "Plan mode **disabled** — mutations unblocked.",
      action: "refresh",
    };
  } catch (err) {
    const msg = String(err);
    if (msg.includes("plan mode is disabled")) {
      return {
        content:
          "Plan mode is disabled at the config level. Set `agents.defaults.planMode.enabled: true` and restart the gateway.",
      };
    }
    return { content: `Failed to set plan mode: ${msg}` };
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
    const result = await client.request<{
      compacted?: boolean;
      reason?: string;
      result?: { tokensBefore?: number; tokensAfter?: number };
    }>("sessions.compact", { key: sessionKey });
    if (result?.compacted) {
      const before = result.result?.tokensBefore;
      const after = result.result?.tokensAfter;
      const tokenSummary =
        typeof before === "number" && typeof after === "number"
          ? ` (${before.toLocaleString()} -> ${after.toLocaleString()} tokens)`
          : "";
      return { content: `Context compacted successfully${tokenSummary}.`, action: "refresh" };
    }
    if (typeof result?.reason === "string" && result.reason.trim()) {
      return { content: `Compaction skipped: ${result.reason}`, action: "refresh" };
    }
    return { content: "Compaction skipped.", action: "refresh" };
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
    const requestedModel = args.trim();
    const [patched, resolvedModelCatalog] = await Promise.all([
      client.request<SessionsPatchResult>("sessions.patch", {
        key: sessionKey,
        model: requestedModel,
      }),
      modelCatalog
        ? Promise.resolve(modelCatalog)
        : loadModelCatalog(client, { allowFailure: true }),
    ]);
    const resolvedModel = patched.resolved?.model ?? requestedModel;
    let resolvedValue = resolvePreferredServerChatModelValue(
      resolvedModel,
      patched.resolved?.modelProvider,
      resolvedModelCatalog,
    );
    const requestedOverride = createChatModelOverride(requestedModel);
    const resolvedProvider = patched.resolved?.modelProvider?.trim();
    if (
      requestedOverride?.kind === "qualified" &&
      resolvedProvider &&
      resolvedValue &&
      !resolvedValue.toLowerCase().startsWith(`${resolvedProvider.toLowerCase()}/`) &&
      requestedOverride.value.toLowerCase().endsWith(`/${resolvedModel.trim().toLowerCase()}`)
    ) {
      resolvedValue = requestedOverride.value;
    }
    return {
      content: `Model set to \`${requestedModel}\`.`,
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
          formatThinkingLevels(session?.modelProvider),
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
        content: `Unrecognized thinking level "${rawLevel}". Valid levels: ${formatThinkingLevels(session?.modelProvider)}.`,
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
  const rawMode = normalizeLowercaseStringOrEmpty(args);

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

/**
 * Set the session's plan-mode flag on the backend (PR-8).
 *
 * - `"plan"`: arms the runtime mutation gate — write/edit/exec/etc. are
 *   blocked until the user approves a plan via the approval flow OR the
 *   user toggles back to `"normal"`.
 * - `"normal"`: clears any pending plan-mode state and unblocks mutations.
 *
 * Mirrors the `thinkingLevel` / `fastMode` patch pattern above so
 * consumers (the mode switcher chip, `/plan` slash command if we add
 * one later) get a single helper they can call without knowing the
 * wire shape. Throws on patch failure so callers can surface an error
 * rather than silently failing state updates.
 */
export async function setSessionPlanMode(
  client: GatewayBrowserClient,
  sessionKey: string,
  mode: "plan" | "normal",
): Promise<void> {
  await client.request("sessions.patch", { key: sessionKey, planMode: mode });
}

/**
 * PR-10: toggle the session's plan-mode autoApprove flag.
 *
 * - `true`: future `exit_plan_mode` submissions auto-resolve as
 *   "approve" without user confirmation. The plan-snapshot persister's
 *   auto-approve branch (`autoApproveIfEnabled`) reads this flag and
 *   fires the approve action immediately on emission.
 * - `false`: clears the flag. Pending plans surfaced after this point
 *   wait for manual confirmation through the inline approval card or
 *   channel-native buttons (PR-11).
 *
 * The patch handler accepts the toggle even when no plan-mode session
 * is currently active — this lets users pre-arm auto-approve before
 * entering plan mode, matching the chip's "Plan ⚡" intent.
 */
export async function setSessionPlanAutoApprove(
  client: GatewayBrowserClient,
  sessionKey: string,
  autoEnabled: boolean,
): Promise<void> {
  await client.request("sessions.patch", {
    key: sessionKey,
    planApproval: { action: "auto", autoEnabled },
  });
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
  const normalizedTarget = normalizeLowercaseStringOrEmpty(target);
  if (!target) {
    return { content: "Usage: `/kill <id|all>`" };
  }
  try {
    const sessions = await client.request<SessionsListResult>("sessions.list", {});
    const matched = resolveKillTargets(sessions?.sessions ?? [], sessionKey, target);
    if (matched.length === 0) {
      return {
        content:
          normalizedTarget === "all"
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
            normalizedTarget === "all"
              ? "No active sub-agent runs to abort."
              : `No active runs matched \`${target}\`.`,
        };
      }
      throw rejected[0]?.reason ?? new Error("abort failed");
    }

    if (normalizedTarget === "all") {
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
  const normalizedTarget = normalizeLowercaseStringOrEmpty(target);
  if (!normalizedTarget) {
    return [];
  }

  const keys = new Set<string>();
  const normalizedCurrentSessionKey = normalizeLowercaseStringOrEmpty(currentSessionKey);
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
    const normalizedKey = normalizeLowercaseStringOrEmpty(key);
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
  return normalizeOptionalLowercaseString(key);
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
  const normalizedTarget = normalizeLowercaseStringOrEmpty(target);
  if (!normalizedTarget) {
    return [];
  }
  const normalizedCurrentSessionKey = normalizeLowercaseStringOrEmpty(currentSessionKey);
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
    const normalizedKey = normalizeLowercaseStringOrEmpty(key);
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
      normalizedKey === normalizedTarget ||
      normalizedKey.endsWith(`:subagent:${normalizedTarget}`) ||
      normalizedKey === `subagent:${normalizedTarget}` ||
      normalizeLowercaseStringOrEmpty(session.label) === normalizedTarget;
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
 *
 * Ended subagents are still resolved here so explicit `/steer <id> ...`
 * can surface the correct "No active run matched" message and `/redirect <id> ...`
 * can restart that specific session instead of silently steering the current one.
 */
async function resolveSteerTarget(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<
  | { key: string; message: string; label?: string; sessions?: SessionsListResult }
  | { error: string }
> {
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
    if (rest && normalizeLowercaseStringOrEmpty(maybeTarget) !== "all") {
      const sessions =
        context.sessionsResult ?? (await client.request<SessionsListResult>("sessions.list", {}));
      const matched = resolveSteerSubagent(sessions?.sessions ?? [], sessionKey, maybeTarget);
      if (matched.length === 1) {
        return { key: matched[0], message: rest, label: maybeTarget, sessions };
      }
      if (matched.length > 1) {
        return { error: `Multiple sub-agents match \`${maybeTarget}\`. Be more specific.` };
      }
    }
  }
  return { key: sessionKey, message: trimmed };
}

function isActiveSteerSession(session: GatewaySessionRow | undefined): boolean {
  return session?.status === "running" && session.endedAt == null;
}

/** Soft inject — queues a message into the active run via chat.send (deliver: false). */
async function executeSteer(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const resolved = await resolveSteerTarget(client, sessionKey, args, context);
    if ("error" in resolved) {
      return {
        content: resolved.error === "empty" ? "Usage: `/steer [id] <message>`" : resolved.error,
      };
    }
    const sessions =
      resolved.sessions ?? (await client.request<SessionsListResult>("sessions.list", {}));
    const targetSession = resolveCurrentSession(sessions, resolved.key);
    if (!isActiveSteerSession(targetSession)) {
      return {
        content: resolved.label
          ? `No active run matched \`${resolved.label}\`. Use \`/redirect\` instead.`
          : "No active run. Use the chat input or `/redirect` instead.",
      };
    }
    await client.request("chat.send", {
      sessionKey: resolved.key,
      message: resolved.message,
      deliver: false,
      idempotencyKey: generateUUID(),
    });
    return {
      content: resolved.label ? `Steered \`${resolved.label}\`.` : "Steered.",
      pendingCurrentRun: resolved.key === sessionKey,
    };
  } catch (err) {
    return { content: `Failed to steer: ${String(err)}` };
  }
}

/** Hard redirect — aborts the active run and restarts with a new message. */
async function executeRedirect(
  client: GatewayBrowserClient,
  sessionKey: string,
  args: string,
  context: SlashCommandContext,
): Promise<SlashCommandResult> {
  try {
    const resolved = await resolveSteerTarget(client, sessionKey, args, context);
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
