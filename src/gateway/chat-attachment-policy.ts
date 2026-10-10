// Connection-level chat attachment ceilings shared by the parser and the
// `hello-ok` handshake. Kept out of chat-attachments.ts so the handshake path
// does not pull the media probe/store graph in just to read two numbers.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChatAttachmentFrameBudgetBytes } from "../shared/chat-attachment-frame-budget.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";

const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 20;

const MAX_ADVERTISED_ATTACHMENT_BYTES = resolveChatAttachmentFrameBudgetBytes(MAX_PAYLOAD_BYTES);

/** Default decoded-size ceiling when `agents.defaults.mediaMaxMb` is unset or invalid. */
export const DEFAULT_CHAT_ATTACHMENT_MAX_BYTES = DEFAULT_CHAT_ATTACHMENT_MAX_MB * 1024 * 1024;

export function resolveChatAttachmentMaxBytes(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.mediaMaxMb;
  const mb = asPositiveFiniteNumber(configured) ?? DEFAULT_CHAT_ATTACHMENT_MAX_MB;
  // mediaMaxMb only has to be positive, so a sub-byte value would floor to 0 and
  // a huge one overflows to Infinity, which serializes as null on the handshake
  // frame and fails its integer schema. Both ends have to stay representable.
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(mb * 1024 * 1024)));
}

/**
 * Connection-wide decoded-size ceilings; MIME and count limits depend on the
 * entrypoint and model. Images must also fit the agent-hydration cap.
 */
export function resolveChatAttachmentPolicy(cfg: OpenClawConfig) {
  const maxBytes = Math.min(resolveChatAttachmentMaxBytes(cfg), MAX_ADVERTISED_ATTACHMENT_BYTES);
  return { maxBytes, maxImageBytes: Math.min(maxBytes, MAX_IMAGE_BYTES) };
}
