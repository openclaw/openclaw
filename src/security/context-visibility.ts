import type { ContextVisibilityMode } from "../config/types.base.js";

/** Supplemental context classes that can be hidden independently from the main message. */
export type ContextVisibilityKind = "history" | "thread" | "quote" | "forwarded";

export type ContextVisibilityDecisionReason =
  | "mode_all"
  | "sender_allowed"
  /** Quote-only visibility mode permits quoted context even when sender is not allowed. */
  | "quote_override"
  | "blocked";

export type ContextVisibilityDecision = {
  include: boolean;
  reason: ContextVisibilityDecisionReason;
};

export function evaluateSupplementalContextVisibility(params: {
  mode: ContextVisibilityMode;
  kind: ContextVisibilityKind;
  senderAllowed: boolean;
}): ContextVisibilityDecision {
  if (params.mode === "all") {
    return { include: true, reason: "mode_all" };
  }
  if (params.senderAllowed) {
    return { include: true, reason: "sender_allowed" };
  }
  if (params.mode === "allowlist_quote" && params.kind === "quote") {
    return { include: true, reason: "quote_override" };
  }
  // Fail closed: unknown or non-matching policy combinations must omit
  // supplemental context rather than leaking sender history/thread data.
  return { include: false, reason: "blocked" };
}

export function shouldIncludeSupplementalContext(params: {
  mode: ContextVisibilityMode;
  kind: ContextVisibilityKind;
  senderAllowed: boolean;
}): boolean {
  return evaluateSupplementalContextVisibility(params).include;
}

export function filterSupplementalContextItems<T>(params: {
  /** Candidate supplemental context items in original delivery order. */
  items: readonly T[];
  mode: ContextVisibilityMode;
  kind: ContextVisibilityKind;
  /** Per-item allowlist predicate for the sender or source identity. */
  isSenderAllowed: (item: T) => boolean;
}): { items: T[]; omitted: number } {
  const items = params.items.filter((item) =>
    shouldIncludeSupplementalContext({
      mode: params.mode,
      kind: params.kind,
      senderAllowed: params.isSenderAllowed(item),
    }),
  );
  return {
    items,
    omitted: params.items.length - items.length,
  };
}
