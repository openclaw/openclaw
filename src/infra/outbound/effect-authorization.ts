import { stableStringify } from "../../agents/stable-stringify.js";
// Final outbound-effect authorization binds policy decisions to the exact
// post-hook payload that reaches a channel adapter.
import type { ReplyPayload } from "../../auto-reply/types.js";
import { sha256Hex } from "../crypto-digest.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";

const EFFECT_AUTHORIZATION_VERSION = 1 as const;
const EFFECT_DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const MEDIA_ALIAS_RE = /^media:[0-9]+$/u;

export type OutboundEffectAuthorizationMediaAlias = {
  source: string;
  alias: string;
};

export type QueuedOutboundEffectAuthorization = {
  version: typeof EFFECT_AUTHORIZATION_VERSION;
  state: "pending" | "sealed" | "authorized";
  digest: string;
  mediaAliases: OutboundEffectAuthorizationMediaAlias[];
};

/** Durable provenance for deciding whether a seal-less queued send crossed message-action policy. */
export type OutboundEffectAuthorizationScope = "not-applicable" | "message-action";

/** JSON-safe proof that one queue row reached its final pre-dispatch barrier. */
export type OutboundEffectAuthorizationSealHandle = {
  kind: "outbound-effect-authorization";
  version: typeof EFFECT_AUTHORIZATION_VERSION;
  id: string;
  digest: string;
};

export type OutboundEffectAuthorizationBarrierOutcome =
  | {
      status: "sealed";
      digest: string;
      handle: OutboundEffectAuthorizationSealHandle | null;
    }
  | { status: "denied"; error: unknown };

/** Live-only callbacks that bind an earlier policy decision to the final payload. */
export type OutboundEffectAuthorizationInput = {
  authorizedPayload: ReplyPayload;
  /** False keeps only an all-leaf ordering barrier; its durable row still fails closed. */
  enforceFinalPayloadAuthorization?: boolean;
  /** Re-authorize only when hooks or channel rendering changed the semantic payload. */
  authorizeChangedPayload?: (payload: ReplyPayload) => Promise<void>;
  /** Optional all-leaf barrier; denied leaves arrive too, preventing broadcast deadlock. */
  waitForAuthorizationBarrier?: (
    outcome: OutboundEffectAuthorizationBarrierOutcome,
  ) => Promise<void>;
};

/** Permanent pre-dispatch failure. Delivery must never hide this behind bestEffort. */
export class OutboundEffectAuthorizationError extends PlatformMessageNotDispatchedError {
  constructor(message: string, cause: unknown) {
    super(message, { cause, retryable: false });
    this.name = "OutboundEffectAuthorizationError";
  }
}

export function isOutboundEffectAuthorizationError(
  error: unknown,
): error is OutboundEffectAuthorizationError {
  return error instanceof OutboundEffectAuthorizationError;
}

function encodeMediaReference(source: unknown, aliases: ReadonlyMap<string, string>): unknown {
  if (typeof source !== "string") {
    return source;
  }
  const alias = aliases.get(source);
  return alias
    ? { kind: "staged-media-alias", value: alias }
    : { kind: "media-source", value: source };
}

function toJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return null;
  }
  return JSON.parse(serialized) as unknown;
}

/** SHA-256 of the JSON-stable, policy-relevant payload with staged paths aliased. */
export function digestOutboundEffectPayload(
  payload: ReplyPayload,
  mediaAliases: readonly OutboundEffectAuthorizationMediaAlias[] = [],
): string {
  const aliases = new Map(mediaAliases.map((entry) => [entry.source, entry.alias] as const));
  const projection: Record<string, unknown> = { ...payload };
  // Canonical outbound planning materializes these two false defaults. Keep
  // every other false value: fields such as replyToCurrent are tri-state.
  if (projection.replyToTag === false) {
    delete projection.replyToTag;
  }
  if (projection.audioAsVoice === false) {
    delete projection.audioAsVoice;
  }
  if (payload.mediaUrl !== undefined) {
    projection.mediaUrl = encodeMediaReference(payload.mediaUrl, aliases);
  }
  if (payload.mediaUrls !== undefined) {
    projection.mediaUrls = payload.mediaUrls.map((source) => encodeMediaReference(source, aliases));
  }
  const canonical = stableStringify({
    version: EFFECT_AUTHORIZATION_VERSION,
    payload: toJsonValue(projection),
  });
  return `sha256:${sha256Hex(canonical)}`;
}

export function createPendingOutboundEffectAuthorization(params: {
  authorizedPayload: ReplyPayload;
  liveMediaAliases: readonly OutboundEffectAuthorizationMediaAlias[];
  queuedMediaAliases: readonly OutboundEffectAuthorizationMediaAlias[];
}): QueuedOutboundEffectAuthorization {
  return {
    version: EFFECT_AUTHORIZATION_VERSION,
    state: "pending",
    digest: digestOutboundEffectPayload(params.authorizedPayload, params.liveMediaAliases),
    mediaAliases: [...params.queuedMediaAliases],
  };
}

/** Strict runtime decoder. Presence plus invalid shape is not a legacy row. */
export function parseQueuedOutboundEffectAuthorization(
  value: unknown,
): QueuedOutboundEffectAuthorization | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== EFFECT_AUTHORIZATION_VERSION ||
    (record.state !== "pending" && record.state !== "sealed" && record.state !== "authorized") ||
    typeof record.digest !== "string" ||
    !EFFECT_DIGEST_RE.test(record.digest) ||
    !Array.isArray(record.mediaAliases)
  ) {
    return null;
  }
  const sources = new Set<string>();
  const aliases = new Set<string>();
  const mediaAliases: OutboundEffectAuthorizationMediaAlias[] = [];
  for (const candidate of record.mediaAliases) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return null;
    }
    const aliasRecord = candidate as Record<string, unknown>;
    if (
      typeof aliasRecord.source !== "string" ||
      !aliasRecord.source ||
      typeof aliasRecord.alias !== "string" ||
      !MEDIA_ALIAS_RE.test(aliasRecord.alias) ||
      sources.has(aliasRecord.source) ||
      aliases.has(aliasRecord.alias)
    ) {
      return null;
    }
    sources.add(aliasRecord.source);
    aliases.add(aliasRecord.alias);
    mediaAliases.push({ source: aliasRecord.source, alias: aliasRecord.alias });
  }
  return {
    version: EFFECT_AUTHORIZATION_VERSION,
    state: record.state,
    digest: record.digest,
    mediaAliases,
  };
}
