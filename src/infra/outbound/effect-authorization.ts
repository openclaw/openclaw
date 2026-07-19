import { isProxy } from "node:util/types";
import { stableStringify } from "../../agents/stable-stringify.js";
// Final outbound-effect authorization binds policy decisions to the exact
// post-hook payload that reaches a channel adapter.
import { copyReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
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
  /** Re-authorize and return the exact snapshot that may reach transport. */
  authorizeChangedPayload?: (payload: ReplyPayload) => Promise<ReplyPayload>;
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

const OUTBOUND_EFFECT_MAX_DEPTH = 32;
const OUTBOUND_EFFECT_MAX_NODES = 4096;
const OMIT_OUTBOUND_EFFECT_VALUE = Symbol("omit-outbound-effect-value");

type OutboundEffectMaterializationState = {
  ancestors: WeakSet<object>;
  depth: number;
  nodes: number;
};

function materializeOutboundEffectValue(
  value: unknown,
  state: OutboundEffectMaterializationState,
): unknown {
  state.nodes += 1;
  if (state.nodes > OUTBOUND_EFFECT_MAX_NODES || state.depth > OUTBOUND_EFFECT_MAX_DEPTH) {
    throw new TypeError("Outbound effect payload exceeds materialization limits");
  }
  if (value === undefined) {
    return OMIT_OUTBOUND_EFFECT_VALUE;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("Outbound effect payload must contain only plain data");
  }
  if (isProxy(value)) {
    throw new TypeError("Outbound effect payload must not contain proxies");
  }
  if (state.ancestors.has(value)) {
    throw new TypeError("Outbound effect payload must not contain cycles");
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError("Outbound effect payload arrays must use the standard prototype");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !(/^(?:0|[1-9]\d*)$/u.test(key) && Number(key) < value.length)),
      )
    ) {
      throw new TypeError("Outbound effect payload arrays must not have custom properties");
    }
    state.ancestors.add(value);
    state.depth += 1;
    try {
      const snapshot: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("Outbound effect payload arrays must contain plain data entries");
        }
        const entry = materializeOutboundEffectValue(descriptor.value, state);
        if (entry === OMIT_OUTBOUND_EFFECT_VALUE) {
          throw new TypeError("Outbound effect payload arrays must not contain undefined entries");
        }
        snapshot.push(entry);
      }
      return snapshot;
    } finally {
      state.depth -= 1;
      state.ancestors.delete(value);
    }
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Outbound effect payload objects must use a plain prototype");
  }
  state.ancestors.add(value);
  state.depth += 1;
  try {
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError("Outbound effect payload objects must not have symbol properties");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Outbound effect payload objects must contain enumerable data fields");
      }
      const entry = materializeOutboundEffectValue(descriptor.value, state);
      if (entry === OMIT_OUTBOUND_EFFECT_VALUE) {
        continue;
      }
      Object.defineProperty(snapshot, key, {
        value: entry,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  } finally {
    state.depth -= 1;
    state.ancestors.delete(value);
  }
}

/** Detached plain-data snapshot used by both authorization and transport dispatch. */
export function materializeOutboundEffectData<T>(value: T): T {
  const snapshot = materializeOutboundEffectValue(value, {
    ancestors: new WeakSet(),
    depth: 0,
    nodes: 0,
  });
  if (snapshot === OMIT_OUTBOUND_EFFECT_VALUE) {
    throw new TypeError("Outbound effect payload must be defined");
  }
  return snapshot as T;
}

export function materializeOutboundEffectPayload(payload: ReplyPayload): ReplyPayload {
  return copyReplyPayloadMetadata(payload, materializeOutboundEffectData(payload));
}

/** SHA-256 of the JSON-stable, policy-relevant payload with staged paths aliased. */
export function digestOutboundEffectPayload(
  payload: ReplyPayload,
  mediaAliases: readonly OutboundEffectAuthorizationMediaAlias[] = [],
): string {
  const snapshot = materializeOutboundEffectPayload(payload);
  const aliases = new Map(mediaAliases.map((entry) => [entry.source, entry.alias] as const));
  const projection: Record<string, unknown> = { ...snapshot };
  // Canonical outbound planning materializes these two false defaults. Keep
  // every other false value: fields such as replyToCurrent are tri-state.
  if (projection.replyToTag === false) {
    delete projection.replyToTag;
  }
  if (projection.audioAsVoice === false) {
    delete projection.audioAsVoice;
  }
  if (snapshot.mediaUrl !== undefined) {
    projection.mediaUrl = encodeMediaReference(snapshot.mediaUrl, aliases);
  }
  if (snapshot.mediaUrls !== undefined) {
    projection.mediaUrls = snapshot.mediaUrls.map((source) =>
      encodeMediaReference(source, aliases),
    );
  }
  const canonical = stableStringify({
    version: EFFECT_AUTHORIZATION_VERSION,
    payload: projection,
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
