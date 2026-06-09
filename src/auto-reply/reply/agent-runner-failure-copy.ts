// Centralizes user-facing failure copy for external agent runner errors.
import { t as runtimeT } from "../../wizard/i18n/index.js";

export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT = runtimeT(
  "runtime.channel.genericExternalRunFailure",
);

export const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT = runtimeT(
  "runtime.channel.heartbeatExternalRunFailure",
);

/** True when text is exactly the generic external run failure copy. */
export function isGenericExternalRunFailureText(text: string | undefined): boolean {
  return text?.trim() === GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}

/** Replaces trailing generic failure text with heartbeat-specific copy. */
export function replaceGenericExternalRunFailureText(text: string): {
  text: string;
  replaced: boolean;
} {
  if (isGenericExternalRunFailureText(text)) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true };
  }

  const genericStart = text.indexOf(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
  if (genericStart < 0) {
    return { text, replaced: false };
  }

  const trailing = text.slice(genericStart + GENERIC_EXTERNAL_RUN_FAILURE_TEXT.length).trim();
  if (trailing) {
    return { text, replaced: false };
  }

  const prefix = text.slice(0, genericStart).trimEnd();
  return {
    text: prefix
      ? `${prefix} ${HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT}`
      : HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    replaced: true,
  };
}
