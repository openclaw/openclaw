import { parseSlackTarget } from "../../../slack/targets.js";

export function normalizeSlackMessagingTarget(raw: string): string | undefined {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  return target?.normalized;
}

export function looksLikeSlackTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^<@([A-Z0-9]+)>$/i.test(trimmed)) {
    return true;
  }
  if (/^(user|channel):/i.test(trimmed)) {
    return true;
  }
  if (/^slack:/i.test(trimmed)) {
    return true;
  }
  // Only treat #/@ prefixed strings as IDs if followed by a valid Slack ID pattern.
  // This allows channel/user names (e.g., #general, @john) to be resolved via directory lookup.
  if (/^#[CUWGD][A-Z0-9]{8,}$/i.test(trimmed)) {
    return true;
  }
  if (/^@[UW][A-Z0-9]{8,}$/i.test(trimmed)) {
    return true;
  }
  return /^[CUWGD][A-Z0-9]{8,}$/i.test(trimmed);
}
