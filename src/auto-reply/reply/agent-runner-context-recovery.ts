import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope-config.js";
import { resolveContextTokensForModel } from "../../agents/context.js";
import type { ModelRef } from "../../agents/model-ref-shared.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { quoteCliArg } from "../../cli/quote-cli-arg.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

function modelRefsEqual(left: ModelRef, right: ModelRef | undefined): boolean {
  const provider = normalizeLowercaseStringOrEmpty(left.provider);
  const model = normalizeLowercaseStringOrEmpty(left.model);
  return Boolean(
    provider &&
    model &&
    provider === normalizeLowercaseStringOrEmpty(right?.provider) &&
    model === normalizeLowercaseStringOrEmpty(right?.model),
  );
}

function formatContextWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  }
  return `${Math.round(tokens / 1024)}k`;
}

function resolveContextWindowForHint(params: {
  cfg: FollowupRun["run"]["config"];
  ref: ModelRef;
  activeSessionEntry?: SessionEntry;
}) {
  const sessionContextTokens = asPositiveFiniteNumber(params.activeSessionEntry?.contextTokens);
  const modelContextTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.ref.provider,
    model: params.ref.model,
    allowAsyncLoad: false,
  });
  return (
    modelContextTokens ??
    (sessionContextTokens === undefined ? undefined : Math.floor(sessionContextTokens))
  );
}

function resolveHeartbeatBleedHint(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  primaryProvider?: string;
  primaryModel?: string;
  activeSessionEntry?: SessionEntry;
}): string | undefined {
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  const runtimeProvider = normalizeOptionalString(params.activeSessionEntry?.modelProvider);
  const runtimeModel = normalizeOptionalString(params.activeSessionEntry?.model);
  if (!primaryProvider || !primaryModel || !runtimeProvider || !runtimeModel) {
    return undefined;
  }

  const primaryRef = { provider: primaryProvider, model: primaryModel };
  const runtimeRef = { provider: runtimeProvider, model: runtimeModel };
  if (modelRefsEqual(primaryRef, runtimeRef)) {
    return undefined;
  }
  const defaultModel = normalizeOptionalString(params.cfg.agents?.defaults?.heartbeat?.model);
  const agentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const agentModel = agentId
    ? normalizeOptionalString(resolveAgentConfig(params.cfg, agentId)?.heartbeat?.model)
    : undefined;
  const heartbeatModelRaw = agentModel ?? defaultModel;
  const heartbeatRef = heartbeatModelRaw
    ? resolveModelRefFromString({
        cfg: params.cfg,
        raw: heartbeatModelRaw,
        defaultProvider: primaryProvider,
      })?.ref
    : undefined;
  if (!modelRefsEqual(runtimeRef, heartbeatRef)) {
    return undefined;
  }

  const runtimeWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    ref: runtimeRef,
    activeSessionEntry: params.activeSessionEntry,
  });
  const primaryWindow = resolveContextWindowForHint({
    cfg: params.cfg,
    ref: primaryRef,
  });
  if (
    runtimeWindow !== undefined &&
    primaryWindow !== undefined &&
    runtimeWindow >= primaryWindow
  ) {
    return undefined;
  }

  const runtimeLabel =
    runtimeWindow !== undefined && runtimeWindow > 0
      ? ` (${formatContextWindowLabel(runtimeWindow)} context)`
      : "";
  return (
    `\n\nThe previous heartbeat turn left this session on ${runtimeProvider}/${runtimeModel}` +
    `${runtimeLabel} instead of ${primaryProvider}/${primaryModel}. This matches the configured ` +
    "`heartbeat.model`, so the overflow is likely heartbeat model bleed rather than a " +
    "compaction-buffer problem. Set `heartbeat.isolatedSession: true`, enable " +
    "`heartbeat.lightContext: true`, or use a heartbeat model with a larger context window."
  );
}

export function buildContextOverflowRecoveryText(params: {
  cfg: FollowupRun["run"]["config"];
  agentId?: string;
  sessionKey?: string;
  primaryProvider?: string;
  primaryModel?: string;
  runtimeProvider?: string;
  runtimeModel?: string;
  activeSessionEntry?: SessionEntry;
}): string {
  // Retrying or /compact repeats the LLM compaction that just failed, so the
  // session-preserving fallback is mechanical trimming through the Gateway.
  const prefix =
    "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Use /new to start a fresh session.";
  // quoteCliArg leaves ordinary keys bare, so they paste into cmd.exe, PowerShell, and POSIX shells.
  const sessionKeyArg = params.sessionKey ? quoteCliArg(params.sessionKey) : "<session-key>";
  const agentArg = params.agentId ? ` --agent ${quoteCliArg(params.agentId)}` : "";
  const compactCommand = (keyArg: string) =>
    `\`${formatCliCommand(`openclaw sessions compact ${keyArg}${agentArg} --max-lines 200`)}\``;
  // cmd.exe keeps single quotes as key characters; inside double quotes it leaves
  // ! and $ (Matrix keys) literal while delayed expansion is off, its default.
  const commandPromptForm =
    params.sessionKey && sessionKeyArg !== params.sessionKey
      ? ` (macOS, Linux, or PowerShell) or ${compactCommand(`"${params.sessionKey}"`)} (Windows Command Prompt)`
      : "";
  const trimHint =
    "\n\nTo keep this session instead, an operator can trim its transcript. Trimming permanently deletes older history and keeps no backup, so run " +
    `\`${formatCliCommand("openclaw backup create")}\` first if that history matters, then ` +
    `${compactCommand(sessionKeyArg)}${commandPromptForm}.`;
  const explicitRuntimeMatchesSession =
    !params.runtimeProvider ||
    !params.runtimeModel ||
    (params.runtimeProvider === params.activeSessionEntry?.modelProvider &&
      params.runtimeModel === params.activeSessionEntry?.model);
  const heartbeatBleedHint = explicitRuntimeMatchesSession
    ? resolveHeartbeatBleedHint(params)
    : undefined;
  return (
    prefix + (heartbeatBleedHint ?? "\n\nTry a model with a larger context window.") + trimHint
  );
}
