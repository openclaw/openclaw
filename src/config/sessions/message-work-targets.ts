import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { patchSessionEntry } from "./store.js";
import type { SessionEntry, SessionMessageWorkTarget } from "./types.js";

const MESSAGE_WORK_TARGET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_WORK_TARGETS = 50;

function normalizeKeyPart(value: unknown): string | undefined {
  return normalizeOptionalString(value == null ? undefined : String(value));
}

function normalizeTargets(targets: unknown, now = Date.now()): SessionMessageWorkTarget[] {
  if (!Array.isArray(targets)) {
    return [];
  }
  return targets.filter((entry): entry is SessionMessageWorkTarget =>
    Boolean(
      normalizeKeyPart(entry?.channel) &&
      normalizeKeyPart(entry?.to) &&
      normalizeKeyPart(entry?.messageId) &&
      typeof entry?.recordedAt === "number" &&
      now - entry.recordedAt <= MESSAGE_WORK_TARGET_TTL_MS,
    ),
  );
}

function sameScope(
  entry: Pick<SessionMessageWorkTarget, "channel" | "to" | "messageId">,
  lookup: Pick<SessionMessageWorkTarget, "channel" | "to" | "messageId">,
): boolean {
  return (
    entry.channel === lookup.channel &&
    entry.to === lookup.to &&
    entry.messageId === lookup.messageId
  );
}

function resolveSessionStorePath(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  sessionKey: string;
  storePath?: string;
}): string | undefined {
  if (params.storePath) {
    return params.storePath;
  }
  if (!params.cfg) {
    return undefined;
  }
  return resolveStorePath(params.cfg.session?.store, {
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
  });
}

export async function recordSessionMessageWorkTarget(params: {
  cfg?: Pick<OpenClawConfig, "session">;
  storePath?: string;
  sessionKey: string | undefined;
  channel: string;
  to: string | number;
  messageId: string | number | undefined;
  threadId?: string | number;
}): Promise<SessionEntry | null> {
  const sessionKey = normalizeKeyPart(params.sessionKey);
  const channel = normalizeKeyPart(params.channel);
  const to = normalizeKeyPart(params.to);
  const messageId = normalizeKeyPart(params.messageId);
  if (!sessionKey || !channel || !to || !messageId) {
    return null;
  }
  const threadId = normalizeKeyPart(params.threadId);
  const recordedAt = Date.now();
  const target: SessionMessageWorkTarget = {
    channel,
    to,
    messageId,
    ...(threadId ? { threadId } : {}),
    recordedAt,
  };
  const storePath = resolveSessionStorePath({
    cfg: params.cfg,
    sessionKey,
    storePath: params.storePath,
  });
  return await patchSessionEntry({
    sessionKey,
    preserveActivity: true,
    ...(storePath ? { storePath } : {}),
    update: (entry) => {
      const targets = normalizeTargets(entry.messageWorkTargets, recordedAt).filter(
        (existing) => !sameScope(existing, target),
      );
      targets.push(target);
      return { messageWorkTargets: targets.slice(-MAX_MESSAGE_WORK_TARGETS) };
    },
  });
}

export function resolveSessionMessageWorkTarget(params: {
  sessionStore?: Record<string, SessionEntry>;
  channel: string;
  toCandidates: Array<string | number | undefined>;
  messageId: string | number | undefined;
}): { sessionKey: string; entry: SessionEntry; target: SessionMessageWorkTarget } | undefined {
  const channel = normalizeKeyPart(params.channel);
  const messageId = normalizeKeyPart(params.messageId);
  if (!channel || !messageId || !params.sessionStore) {
    return undefined;
  }
  const toCandidates = new Set(
    params.toCandidates
      .map((candidate) => normalizeKeyPart(candidate))
      .filter((candidate): candidate is string => Boolean(candidate)),
  );
  if (toCandidates.size === 0) {
    return undefined;
  }
  let best:
    | { sessionKey: string; entry: SessionEntry; target: SessionMessageWorkTarget }
    | undefined;
  for (const [sessionKey, entry] of Object.entries(params.sessionStore)) {
    for (const target of normalizeTargets(entry.messageWorkTargets)) {
      if (
        target.channel === channel &&
        target.messageId === messageId &&
        toCandidates.has(target.to) &&
        (!best || target.recordedAt > best.target.recordedAt)
      ) {
        best = { sessionKey, entry, target };
      }
    }
  }
  return best;
}
