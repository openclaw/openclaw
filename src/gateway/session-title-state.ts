import type { SessionEntry } from "../config/sessions/types.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";

type SessionTitleTarget = { storePath: string; sessionKey: string; sessionId: string };
const requestKey = (target: SessionTitleTarget) =>
  `${target.storePath}\0${target.sessionKey}\0${target.sessionId}`;

// One request per session generation; callers share settlement and pending requests
// always leave the registry, including model failures and timeouts.
const pending = new Map<string, Promise<boolean>>();
export const sessionTitleRequests = {
  get(target: SessionTitleTarget) {
    return pending.get(requestKey(target));
  },
  run(target: SessionTitleTarget, create: () => Promise<boolean>) {
    return getOrCreatePromise(pending, requestKey(target), create, { evictOnSettled: true });
  },
};

export function resolveExplicitSessionName(entry: SessionEntry | undefined): string | undefined {
  const label = entry?.label?.trim();
  if (label) {
    return label;
  }
  // autoLabel is device metadata and must not block generated displayName titles.
  return [entry?.displayName, entry?.subject, entry?.groupChannel, entry?.space]
    .map((value) => value?.trim())
    .find(Boolean);
}

export function hasExplicitSessionName(entry: SessionEntry | undefined): boolean {
  return Boolean(resolveExplicitSessionName(entry));
}
