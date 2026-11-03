// Connection-level chat attachment ceilings shared by parsing and hello-ok.
// This owner stays independent of the media probe/store import graph.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveChatAttachmentFrameBudgetBytes } from "../shared/chat-attachment-frame-budget.js";
import { MAX_PAYLOAD_BYTES } from "./payload-limits.js";

const DEFAULT_CHAT_ATTACHMENT_MAX_MB = 20;
const MAX_ADVERTISED_ATTACHMENT_BYTES = resolveChatAttachmentFrameBudgetBytes(MAX_PAYLOAD_BYTES);

/** Default decoded-size ceiling when `attachments.maxFileMb` is unset. */
export const DEFAULT_CHAT_ATTACHMENT_MAX_BYTES = DEFAULT_CHAT_ATTACHMENT_MAX_MB * 1024 * 1024;

function decodedBytes(mb: number): number {
  // Keep internal/direct callers representable as well as validated config.
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(mb * 1024 * 1024)));
}

export function resolveChatAttachmentMaxBytes(cfg: OpenClawConfig): number {
  const mb = cfg.attachments?.maxFileMb ?? DEFAULT_CHAT_ATTACHMENT_MAX_MB;
  return decodedBytes(mb);
}

/** Decoded admission policy, independent of the encoding used by a transport. */
export function resolveChatAttachmentLimits(cfg: OpenClawConfig) {
  const maxBytes = resolveChatAttachmentMaxBytes(cfg);
  const maxTotalBytes =
    cfg.attachments?.maxTotalMb === undefined
      ? Math.max(DEFAULT_CHAT_ATTACHMENT_MAX_BYTES, maxBytes)
      : decodedBytes(cfg.attachments.maxTotalMb);
  const maxMediaBytes = decodedBytes(
    cfg.agents?.defaults?.mediaMaxMb ?? DEFAULT_CHAT_ATTACHMENT_MAX_MB,
  );
  return { maxBytes, maxTotalBytes, maxMediaBytes };
}

/** Connection-wide ceilings; MIME and count limits depend on the entrypoint/model. */
export function resolveChatAttachmentPolicy(cfg: OpenClawConfig) {
  const limits = resolveChatAttachmentLimits(cfg);
  const maxTotalBytes = Math.min(limits.maxTotalBytes, MAX_ADVERTISED_ATTACHMENT_BYTES);
  const maxBytes = Math.min(limits.maxBytes, maxTotalBytes);
  const maxMediaBytes = Math.min(limits.maxMediaBytes, maxBytes);
  return {
    maxBytes,
    maxImageBytes: Math.min(maxMediaBytes, MAX_IMAGE_BYTES),
    maxMediaBytes,
    maxTotalBytes,
  };
}
