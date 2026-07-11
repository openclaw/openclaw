// Cross-channel fast-path for the operator killswitch. Mirrors the fast-abort
// pattern in ./abort.ts: recognized before any LLM/agent involvement so a
// misbehaving agent cannot reason its way around it, and works identically
// regardless of which channel plugin the message arrived on.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  engageKillswitchSync,
  getKillswitchStatusSync,
  releaseKillswitchSync,
} from "../../infra/killswitch.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { FinalizedMsgContext } from "../templating.js";
import { stripStructuralPrefixes } from "./mentions.js";
import { listActiveReplyRunSessionIds } from "./reply-run-registry.js";

/** Exact phrases only: this is an emergency control, not a conversational command. */
export const KILLSWITCH_ENGAGE_PHRASE = "KILLSWITCH-ENGAGE";
export const KILLSWITCH_REVIVE_PHRASE = "KILLSWITCH-REVIVE";

export function isKillswitchEngageText(text: string): boolean {
  return text.trim() === KILLSWITCH_ENGAGE_PHRASE;
}

export function isKillswitchReleaseText(text: string): boolean {
  return text.trim() === KILLSWITCH_REVIVE_PHRASE;
}

/** Aborts every currently active channel-triggered agent run. New runs are
 * already refused by the persisted flag; this stops ones already underway. */
function abortAllActiveEmbeddedAgentRuns(): number {
  let aborted = 0;
  for (const sessionId of listActiveReplyRunSessionIds()) {
    if (abortEmbeddedAgentRun(sessionId)) {
      aborted += 1;
    }
  }
  return aborted;
}

export function formatKillswitchEngageReplyText(abortedRuns: number): string {
  const runsNote = abortedRuns > 0 ? ` ${abortedRuns} in-flight run(s) aborted.` : "";
  return `⚠️ Killswitch engaged. Agent runs are paused until revived.${runsNote} Send ${KILLSWITCH_REVIVE_PHRASE} to resume.`;
}

export function formatKillswitchReleaseReplyText(): string {
  return `✅ Killswitch released. Agent runs are resuming normally.`;
}

/**
 * Detects and handles the killswitch phrases ahead of normal dispatch. Only
 * an owner sender in a direct (non-group) message can trigger it, so a group
 * member or spoofed allowlist entry cannot pause/resume the agent.
 */
export async function tryFastKillswitchFromMessage(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}): Promise<{ handled: boolean; replyText?: string }> {
  const { ctx, cfg } = params;
  const raw = stripStructuralPrefixes(ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "");
  const engaging = isKillswitchEngageText(raw);
  const releasing = !engaging && isKillswitchReleaseText(raw);
  if (!engaging && !releasing) {
    return { handled: false };
  }
  const isGroup = normalizeOptionalLowercaseString(ctx.ChatType) === "group";
  if (isGroup) {
    return { handled: false };
  }
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: ctx.CommandAuthorized,
  });
  // Scoped to Signal for now (the agreed trigger surface); other channels can
  // opt in later by widening this check, since the rest of this function is
  // already channel-agnostic. Reuses auth.providerId rather than reading a raw
  // ctx field, since that's the same provider resolution the owner check itself
  // already trusts (ctx.Surface/OriginatingChannel/Provider fallback chain).
  if (auth.providerId !== "signal") {
    return { handled: false };
  }
  if (!auth.senderIsOwner) {
    return { handled: false };
  }
  const source = "signal" as const;
  if (engaging) {
    engageKillswitchSync({ reason: "channel:signal", source });
    const aborted = abortAllActiveEmbeddedAgentRuns();
    return { handled: true, replyText: formatKillswitchEngageReplyText(aborted) };
  }
  if (!getKillswitchStatusSync().engaged) {
    return { handled: true, replyText: "Killswitch is not engaged." };
  }
  releaseKillswitchSync({ source });
  return { handled: true, replyText: formatKillswitchReleaseReplyText() };
}
