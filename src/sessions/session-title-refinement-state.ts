import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { z } from "zod";

/**
 * Durable refinement state for the opt-in one-time automatic title refinement.
 * Reset naturally: the entry is keyed to sessionId, and every write re-checks
 * sessionId identity, so /reset (new sessionId) and stale async writers are
 * handled by the existing session writer guards.
 */
const SessionTitleRefinementStateSchema = z.strictObject({
  /** User task messages observed after the first generated title existed. */
  taskMessagesSinceTitle: z.number().int().min(0),
  /** True once the single refinement has run (successfully or not). */
  refinementDone: z.boolean(),
  /** Session generation the state was captured against. */
  sessionId: z.string(),
  /** Generated title this state owns; refinement writes must still match it. */
  generatedName: z.string(),
  /** A prepared title's opening task must not count as a later message. */
  skipNextMessage: z.boolean().optional(),
  /** Bounded later task context for the one-time refinement prompt. */
  recentMessages: z.array(z.string().max(500)).max(8).optional(),
});

export type SessionTitleRefinementState = z.infer<typeof SessionTitleRefinementStateSchema>;

/** Default task messages after the first title before the single refinement runs. */
const SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT = 6;
const MAX_RECENT_TITLE_MESSAGES = 8;
const MAX_TITLE_MESSAGE_LENGTH = 500;

function clampRefineAfterMessages(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : SESSION_TITLE_REFINE_AFTER_MESSAGES_DEFAULT;
}

export function resolveSessionTitleRefineConfig(params: {
  cfgSession?: {
    autoTitle?: {
      refine?: boolean;
      refineAfterMessages?: number;
    };
  };
}): { enabled: boolean; afterMessages: number } {
  const autoTitle = params.cfgSession?.autoTitle;
  return {
    enabled: autoTitle?.refine === true,
    afterMessages: clampRefineAfterMessages(autoTitle?.refineAfterMessages),
  };
}

/** Counts one subsequent user task message toward the refinement threshold. */
export function countTitleRefinementMessage(
  state: SessionTitleRefinementState | undefined,
  sessionId: string,
  generatedName: string,
  message?: string,
): SessionTitleRefinementState {
  // A state from a previous session incarnation (/reset) does not count.
  const owned = state && state.sessionId === sessionId ? state : undefined;
  const recentMessages = message?.trim()
    ? [
        ...(owned?.recentMessages ?? []),
        truncateUtf16Safe(message.trim(), MAX_TITLE_MESSAGE_LENGTH),
      ].slice(-MAX_RECENT_TITLE_MESSAGES)
    : owned?.recentMessages;
  return {
    taskMessagesSinceTitle: (owned?.taskMessagesSinceTitle ?? 0) + 1,
    refinementDone: owned?.refinementDone ?? false,
    sessionId,
    generatedName,
    ...(recentMessages?.length ? { recentMessages } : {}),
  };
}

/**
 * Provenance marker written by the automatic title writer when it persists a
 * generated displayName. Refinement only proceeds when this state exists, so
 * explicit (non-generated) display names are never adopted for refinement.
 */
export function initializeTitleRefinementState(
  sessionId: string,
  generatedName: string,
  options?: { skipNextMessage?: boolean },
): SessionTitleRefinementState {
  return {
    taskMessagesSinceTitle: 0,
    refinementDone: false,
    sessionId,
    generatedName,
    ...(options?.skipNextMessage ? { skipNextMessage: true } : {}),
  };
}
