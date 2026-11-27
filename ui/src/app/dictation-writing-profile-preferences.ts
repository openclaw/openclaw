import {
  createDefaultWritingProfileCatalog,
  prepareWritingProfileImport,
  validateWritingProfileCatalog,
  WRITING_PROFILE_LIMITS,
  WRITING_PROFILES_PREFERENCE_KEY,
  type WritingProfileCatalog,
  type WritingProfileIssue,
} from "../../../src/shared/dictation-writing-profiles.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { saveUserPreferences } from "./user-prefs-cache.ts";
import { loadUserPreferences } from "./user-prefs-request.ts";

export { WRITING_PROFILES_PREFERENCE_KEY };

export type WritingProfilePreferenceSnapshot = Readonly<{
  profileId: string;
  raw: unknown;
  catalog: WritingProfileCatalog | null;
  readOnlyReason: "unsupported-version" | "invalid-catalog" | null;
  issues: readonly WritingProfileIssue[];
  futureVersion?: number;
}>;

export type WritingProfilePreferenceOptions = Readonly<{
  /** The existing UI owner checks its selected profile and request lifetime. */
  isCurrent?: () => boolean;
}>;

type Unavailable = Readonly<{
  status: "no-durable-identity" | "stale" | "error";
}>;
export type WritingProfilePreferenceLoadResult =
  | Readonly<{ status: "ok"; current: WritingProfilePreferenceSnapshot }>
  | Unavailable;
export type WritingProfilePreferenceSaveResult =
  | WritingProfilePreferenceLoadResult
  | Readonly<{ status: "conflict" | "read-only" }>
  | Readonly<{
      status: "invalid";
      issues: readonly WritingProfileIssue[];
      futureVersion?: number;
      /** An explicit import can be exported without interpreting a future schema. */
      quarantinedImport?: string;
    }>;

type SnapshotAuthority = Readonly<{
  client: GatewayBrowserClient;
  generation: number;
  expectedJson: string | null;
}>;
const authorities = new WeakMap<WritingProfilePreferenceSnapshot, SnapshotAuthority>();

/** Transport JSON can contain a future schema deeper than JSON.stringify's stack. */
function serializePreferenceJson(input: unknown): string {
  const frames: { value: object; keys: string[] | null; length: number; index: number }[] = [];
  const ancestors = new Set<object>();
  const fragments: string[] = [];
  const encoder = new TextEncoder();
  let remaining = WRITING_PROFILE_LIMITS.catalogBytes;
  const append = (token: string) => {
    remaining -= encoder.encode(token).byteLength;
    if (remaining < 0) {
      throw new Error("Writing-profile preference exceeds its byte limit");
    }
    fragments.push(token);
  };
  const quoted = (value: string): string => {
    if (value.length > remaining) {
      throw new Error("Writing-profile preference exceeds its byte limit");
    }
    return JSON.stringify(value);
  };
  let value = input;
  while (true) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      append(JSON.stringify(value));
    } else if (typeof value === "string") {
      append(quoted(value));
    } else if (typeof value === "object") {
      const container = value;
      const array = Array.isArray(container);
      const prototype = Object.getPrototypeOf(container);
      if (
        ancestors.has(container) ||
        (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
      ) {
        throw new Error("Invalid writing-profile preference JSON");
      }
      const keys = array ? null : Object.keys(container);
      append(array ? "[" : "{");
      ancestors.add(container);
      frames.push({
        value: container,
        keys,
        length: array ? container.length : keys!.length,
        index: 0,
      });
    } else {
      throw new Error("Invalid writing-profile preference JSON");
    }
    let frame = frames.at(-1);
    while (frame && frame.index === frame.length) {
      append(frame.keys === null ? "]" : "}");
      ancestors.delete(frame.value);
      frames.pop();
      frame = frames.at(-1);
    }
    if (!frame) {
      return fragments.join("");
    }
    if (frame.index > 0) {
      append(",");
    }
    const key = frame.keys === null ? String(frame.index) : frame.keys[frame.index]!;
    if (frame.keys !== null) {
      append(quoted(key));
      append(":");
    }
    const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("Invalid writing-profile preference JSON");
    }
    frame.index++;
    value = descriptor.value;
  }
}

function freezeJson<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next && typeof next === "object" && !Object.isFrozen(next)) {
      Object.freeze(next);
      for (const child of Object.values(next)) {
        pending.push(child);
      }
    }
  }
  return value;
}

function createSnapshot(
  client: GatewayBrowserClient,
  profileId: string,
  generation: number,
  raw: unknown,
): WritingProfilePreferenceSnapshot {
  // Retain a private comparator independent of editor drafts and exported objects.
  const expectedJson = raw === null ? null : serializePreferenceJson(raw);
  const saved = expectedJson === null ? null : JSON.parse(expectedJson);
  const result =
    saved === null
      ? ({ ok: true, catalog: createDefaultWritingProfileCatalog() } as const)
      : validateWritingProfileCatalog(saved);
  const snapshot: WritingProfilePreferenceSnapshot = freezeJson({
    profileId,
    raw: saved,
    catalog: result.ok ? result.catalog : null,
    readOnlyReason: result.ok
      ? null
      : result.futureVersion !== undefined
        ? "unsupported-version"
        : "invalid-catalog",
    issues: result.ok ? [] : result.issues,
    ...(!result.ok && result.futureVersion !== undefined
      ? { futureVersion: result.futureVersion }
      : {}),
  });
  authorities.set(snapshot, { client, generation, expectedJson });
  return snapshot;
}

function isCurrent(
  client: GatewayBrowserClient,
  generation: number,
  options: WritingProfilePreferenceOptions,
): boolean {
  return client.connectionGeneration === generation && (options.isCurrent?.() ?? true);
}

/** Reads only the named preference; absence never creates or activates a catalog. */
export async function loadWritingProfilePreferences(
  client: GatewayBrowserClient,
  profileId: string,
  options: WritingProfilePreferenceOptions = {},
): Promise<WritingProfilePreferenceLoadResult> {
  if (!profileId) {
    return { status: "no-durable-identity" };
  }
  const generation = client.connectionGeneration;
  if (!isCurrent(client, generation, options)) {
    return { status: "stale" };
  }
  try {
    const result = await loadUserPreferences(client, profileId, {
      keys: [WRITING_PROFILES_PREFERENCE_KEY],
    });
    if (!isCurrent(client, generation, options)) {
      return { status: "stale" };
    }
    if (result.status !== "ok") {
      return { status: "no-durable-identity" };
    }
    const raw = Object.hasOwn(result.entries, WRITING_PROFILES_PREFERENCE_KEY)
      ? result.entries[WRITING_PROFILES_PREFERENCE_KEY]
      : null;
    return { status: "ok", current: createSnapshot(client, profileId, generation, raw) };
  } catch {
    return { status: isCurrent(client, generation, options) ? "error" : "stale" };
  }
}

/** The Gateway owns identity and the transaction; an obsolete editor cannot retry blindly. */
export async function saveWritingProfilePreferences(
  client: GatewayBrowserClient,
  current: WritingProfilePreferenceSnapshot,
  next: unknown,
  options: WritingProfilePreferenceOptions = {},
): Promise<WritingProfilePreferenceSaveResult> {
  const authority = authorities.get(current);
  if (
    !authority ||
    authority.client !== client ||
    !isCurrent(client, authority.generation, options)
  ) {
    return { status: "stale" };
  }
  if (current.readOnlyReason !== null) {
    return { status: "read-only" };
  }
  const validated = validateWritingProfileCatalog(next);
  if (!validated.ok) {
    return {
      status: "invalid",
      issues: validated.issues,
      ...(validated.futureVersion !== undefined ? { futureVersion: validated.futureVersion } : {}),
    };
  }
  // Validation captures an immutable catalog before the request can yield.
  const catalog = validated.catalog;
  try {
    const result = await saveUserPreferences(client, {
      entries: { [WRITING_PROFILES_PREFERENCE_KEY]: catalog },
      expectedEntries: {
        [WRITING_PROFILES_PREFERENCE_KEY]:
          authority.expectedJson === null ? null : JSON.parse(authority.expectedJson),
      },
    });
    if (!isCurrent(client, authority.generation, options)) {
      return { status: "stale" };
    }
    if (result.status === "conflict") {
      return { status: "conflict" };
    }
    if (result.status !== "ok") {
      return { status: "no-durable-identity" };
    }
    return {
      status: "ok",
      current: createSnapshot(client, current.profileId, authority.generation, catalog),
    };
  } catch {
    return { status: isCurrent(client, authority.generation, options) ? "error" : "stale" };
  }
}

/** An import is one validated CAS write; imported policy requires a separate enable action. */
export async function importWritingProfilePreferences(
  client: GatewayBrowserClient,
  current: WritingProfilePreferenceSnapshot,
  serialized: string,
  options: WritingProfilePreferenceOptions = {},
): Promise<WritingProfilePreferenceSaveResult> {
  if (new TextEncoder().encode(serialized).byteLength > WRITING_PROFILE_LIMITS.catalogBytes) {
    return { status: "invalid", issues: [{ path: "$", code: "catalog-too-large" }] };
  }
  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch {
    return { status: "invalid", issues: [{ path: "$", code: "invalid-json" }] };
  }
  const prepared = prepareWritingProfileImport(input);
  if (!prepared.ok) {
    return {
      status: "invalid",
      issues: prepared.issues,
      ...(prepared.futureVersion !== undefined
        ? { futureVersion: prepared.futureVersion, quarantinedImport: serialized }
        : {}),
    };
  }
  return saveWritingProfilePreferences(
    client,
    current,
    {
      ...prepared.catalog,
      revision: crypto.randomUUID(),
      profiles: prepared.catalog.profiles.map((profile) =>
        Object.assign({}, profile, { revision: crypto.randomUUID() }),
      ),
    },
    options,
  );
}

/** Future catalogs stay intact and exportable, without being activated or overwritten. */
export function exportWritingProfilePreferences(current: WritingProfilePreferenceSnapshot): string {
  const authority = authorities.get(current);
  if (!authority) {
    throw new Error("Unknown writing-profile preference snapshot");
  }
  return authority.expectedJson ?? serializePreferenceJson(current.catalog);
}
