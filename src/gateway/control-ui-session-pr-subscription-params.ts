import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/primitives.js";
import { CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS } from "./control-ui-contract.js";

function parseSessionKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS) {
    return null;
  }
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const key = entry.trim();
    if (!key || key.length > CHAT_SEND_SESSION_KEY_MAX_LENGTH) {
      return null;
    }
    keys.add(key);
  }
  return [...keys];
}

export function parseControlUiSessionPullRequestsSubscribeParams(
  value: unknown,
): { sessionKeys: string[]; refreshSessionKeys: string[] } | null {
  const raw = asNullableRecord(value);
  if (!raw || !("sessionKeys" in raw)) {
    return null;
  }
  const sessionKeys = parseSessionKeys(raw.sessionKeys);
  const refreshSessionKeys =
    raw.refreshSessionKeys === undefined ? [] : parseSessionKeys(raw.refreshSessionKeys);
  if (!sessionKeys || !refreshSessionKeys) {
    return null;
  }
  const watched = new Set(sessionKeys);
  for (const key of refreshSessionKeys) {
    if (!watched.has(key)) {
      return null;
    }
  }
  return { sessionKeys, refreshSessionKeys };
}
