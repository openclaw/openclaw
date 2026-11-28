/** The system prompt's allowlisted-sender line, bounded and optionally hashed. */
import { createHmac } from "node:crypto";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { MAX_OWNER_PROMPT_CONTENT_BYTES, resolveOwnerPromptNumbers } from "./owner-display.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

export type OwnerIdDisplay = "raw" | "hash";

function formatOwnerDisplayId(ownerId: string, ownerDisplaySecret?: string) {
  const hasSecret = ownerDisplaySecret?.trim();
  const digest = hasSecret
    ? createHmac("sha256", hasSecret).update(ownerId).digest("hex")
    : sha256Hex(ownerId);
  return digest.slice(0, 12);
}

const MAX_OWNER_PROMPT_LINE_BYTES = 1_024;
const OWNER_PROMPT_PREFIX = "Allowlisted senders: ";
const OWNER_PROMPT_SUFFIX = ". Allowlisted != owner.";

function formatRawOwnerDisplayId(ownerId: string, maxBytes: number): string {
  const sanitized = sanitizeForPromptLiteral(ownerId);
  if (Buffer.byteLength(sanitized, "utf8") <= maxBytes) {
    return sanitized;
  }
  if (maxBytes <= 3) {
    return "";
  }
  return `${truncateUtf8Prefix(sanitized, maxBytes - 3)}...`;
}

export function buildOwnerIdentityLine(
  ownerNumbers: string[],
  ownerDisplay: OwnerIdDisplay,
  ownerDisplaySecret?: string,
) {
  const normalized = normalizeStringEntries(resolveOwnerPromptNumbers({ ownerNumbers }));
  if (normalized.length === 0) {
    return undefined;
  }
  const displayOwnerNumbers: string[] = [];
  let remainingBytes = Math.min(
    MAX_OWNER_PROMPT_CONTENT_BYTES,
    MAX_OWNER_PROMPT_LINE_BYTES - Buffer.byteLength(OWNER_PROMPT_PREFIX + OWNER_PROMPT_SUFFIX),
  );
  for (const ownerId of normalized) {
    const separatorBytes = displayOwnerNumbers.length > 0 ? 2 : 0;
    const availableBytes = remainingBytes - separatorBytes;
    if (availableBytes <= 0) {
      break;
    }
    const displayOwnerId =
      ownerDisplay === "hash"
        ? formatOwnerDisplayId(ownerId, ownerDisplaySecret)
        : formatRawOwnerDisplayId(ownerId, availableBytes);
    if (!displayOwnerId) {
      continue;
    }
    const nextBytes = Buffer.byteLength(displayOwnerId, "utf8") + separatorBytes;
    if (nextBytes > remainingBytes) {
      break;
    }
    displayOwnerNumbers.push(displayOwnerId);
    remainingBytes -= nextBytes;
  }
  if (displayOwnerNumbers.length === 0) {
    return undefined;
  }
  return `${OWNER_PROMPT_PREFIX}${displayOwnerNumbers.join(", ")}${OWNER_PROMPT_SUFFIX}`;
}
