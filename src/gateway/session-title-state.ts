import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";

type SessionTitleTarget = {
  storePath: string;
  sessionKey: string;
  sessionId: string;
};
const requestKey = (target: SessionTitleTarget) =>
  `${target.storePath}\0${target.sessionKey}\0${target.sessionId}`;

// One request per session; callers share settlement and pending requests
// always leave the registry, including model failures and timeouts.
const pending = new Map<string, { request: Promise<boolean>; started: boolean }>();
export const sessionTitleRequests = {
  get(target: SessionTitleTarget) {
    return pending.get(requestKey(target))?.request;
  },
  isPending(target: SessionTitleTarget) {
    return pending.get(requestKey(target))?.started === true;
  },
  run(
    target: SessionTitleTarget,
    create: (markStarted: () => void) => Promise<boolean>,
    onStateChanged?: () => void,
  ) {
    const key = requestKey(target);
    const existing = pending.get(key);
    if (existing) {
      return existing.request;
    }
    const request = Promise.resolve().then(() =>
      create(() => {
        owner.started = true;
        onStateChanged?.();
      }),
    );
    const owner = { request, started: false };
    pending.set(key, owner);
    const settle = () => {
      pending.delete(key);
      if (owner.started) {
        onStateChanged?.();
      }
    };
    void request.then(settle, settle);
    return request;
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
