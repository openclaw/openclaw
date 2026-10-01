/**
 * Provenance marker appended to every OpenClaw-injected inbound context header
 * (see `buildInboundUserContextPrefix`). Strippers key on this marker rather
 * than on label text so detection is label-agnostic and never collides with
 * user-typed headings. Fixed (not per-turn random): strippers run on stored
 * text with no out-of-band value, and forging it only strips the forger's own
 * text — no trust boundary depends on it.
 *
 * Duplicated (never imported) in:
 *   - extensions/memory-lancedb/memory-capture-sanitization.ts (extension boundary
 *     forbids core imports)
 *   - apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownPreprocessor.swift, which spells the
 *     same two code points as `\u{27E6}`/`\u{27E7}` escapes
 * Keep every copy equal to this value; a drifted copy silently stops stripping.
 */
export const INBOUND_CONTEXT_MARKER = "⟦openclaw:ctx⟧";

/** Appends the provenance marker to a context header label. */
export function markInboundContextLabel(label: string): string {
  return `${label} ${INBOUND_CONTEXT_MARKER}`;
}

/**
 * Instruction line injected after the `Conversation info:` block when the
 * requester is a verified linked profile. It carries no marker, so strippers
 * match it as an exact line (like the message-tool delivery hints).
 */
export const REQUESTER_PROFILE_GUIDANCE =
  'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';
