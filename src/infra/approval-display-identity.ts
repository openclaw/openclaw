import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MAX_APPROVAL_IDENTITY_DISPLAY_LENGTH = 160;
const APPROVAL_IDENTITY_TRUNCATION_MARKER = "...";
const APPROVAL_IDENTITY_UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const APPROVAL_IDENTITY_WHITESPACE = /\s+/gu;
const APPROVAL_IDENTITY_MARKDOWN_CHARACTERS = /[&<>@`[\]()*_~|\\]/gu;

const MARKDOWN_SAFE_EQUIVALENTS: Record<string, string> = {
  "&": "＆",
  "<": "＜",
  ">": "＞",
  "@": "＠",
  "`": "｀",
  "[": "［",
  "]": "］",
  "(": "（",
  ")": "）",
  "*": "＊",
  _: "＿",
  "~": "～",
  "|": "｜",
  "\\": "＼",
};

function truncateApprovalIdentity(value: string): string {
  if (value.length <= MAX_APPROVAL_IDENTITY_DISPLAY_LENGTH) {
    return value;
  }
  const availableLength =
    MAX_APPROVAL_IDENTITY_DISPLAY_LENGTH - APPROVAL_IDENTITY_TRUNCATION_MARKER.length;
  const prefixLength = Math.ceil(availableLength / 2);
  const suffixLength = Math.floor(availableLength / 2);
  return `${sliceUtf16Safe(value, 0, prefixLength)}${APPROVAL_IDENTITY_TRUNCATION_MARKER}${sliceUtf16Safe(value, -suffixLength)}`;
}

/**
 * Formats agent and session identities for single-line approval prompt text.
 * Raw values remain available on the approval payload for routing and matching.
 */
export function formatApprovalIdentityForDisplay(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .normalize("NFC")
    .replace(APPROVAL_IDENTITY_UNSAFE_CHARACTERS, " ")
    .replace(APPROVAL_IDENTITY_WHITESPACE, " ")
    .trim()
    .replace(
      APPROVAL_IDENTITY_MARKDOWN_CHARACTERS,
      (character) => MARKDOWN_SAFE_EQUIVALENTS[character] ?? "",
    );
  return normalized ? truncateApprovalIdentity(normalized) : undefined;
}
