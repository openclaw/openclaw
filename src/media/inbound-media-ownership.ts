// Inbound media ownership binds a staged media-store object to the session that
// published its reference, so the assistant-media route can enforce origin-session
// authority before it serves bytes.
//
// A staged reference is a copy of bytes the agent already holds, written into the
// shared inbound bucket so the chat display projection can keep a reference. The
// bucket is one of the default media roots, so a reader who learned the reference
// could otherwise fetch it without naming any session, and outlive the visibility of
// the session that published it. This registry records the originating session and the
// route refuses an ownerless or mismatched request.
//
// Records are advisory to nothing and enforced by the route, so a write failure must
// not silently publish an unbound object: recordStagedInboundMedia reports failure and
// the caller keeps the bytes private rather than attaching an unenforceable reference.
import fs from "node:fs/promises";
import path from "node:path";
import { parseInboundMediaUri } from "./media-reference.js";
import { getMediaDir } from "./store.js";

/** Ownership record for one staged inbound media object. */
export type InboundMediaOwnership = {
  /** Epoch ms the object was staged into the shared store. */
  stagedAt: number;
  /** Session that published the reference; absent until its result is persisted. */
  sessionKey?: string;
  agentId?: string;
};

const OWNERSHIP_FILE_NAME = "inbound-ownership.json";
const OWNERSHIP_FILE_MODE = 0o600;
/** Bounded so a long-lived store cannot grow the registry without limit. */
const MAX_OWNERSHIP_ENTRIES = 5000;
const OWNERSHIP_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Depth bound for the reference walk, which runs on every persisted tool result. */
const MAX_REFERENCE_WALK_DEPTH = 6;

type OwnershipIndex = Record<string, InboundMediaOwnership>;

function ownershipFilePath(): string {
  return path.join(getMediaDir(), OWNERSHIP_FILE_NAME);
}

/** Rejects ids that are not a single bounded path component inside the inbound bucket. */
export function isSafeInboundMediaId(id: string): boolean {
  return (
    id.length > 0 &&
    id !== "." &&
    id !== ".." &&
    !id.includes("/") &&
    !id.includes("\\") &&
    !id.includes("\0")
  );
}

/** Parses a canonical media://inbound/<id> reference into its inbound id. */
export function inboundMediaIdFromReference(source: string): string | undefined {
  try {
    const id = parseInboundMediaUri(source)?.id;
    return id && isSafeInboundMediaId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

async function readOwnershipIndex(): Promise<OwnershipIndex> {
  try {
    const raw = await fs.readFile(ownershipFilePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const index: OwnershipIndex = {};
    // SAFETY: parsed is confirmed a non-null, non-array object immediately above.
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isSafeInboundMediaId(id) || !value || typeof value !== "object") {
        continue;
      }
      // SAFETY: value is confirmed a non-null object by the guard on the loop entry above.
      const record = value as Record<string, unknown>;
      if (typeof record.stagedAt !== "number" || !Number.isFinite(record.stagedAt)) {
        continue;
      }
      index[id] = {
        stagedAt: record.stagedAt,
        ...(typeof record.sessionKey === "string" ? { sessionKey: record.sessionKey } : {}),
        ...(typeof record.agentId === "string" ? { agentId: record.agentId } : {}),
      };
    }
    return index;
  } catch {
    return {};
  }
}

function pruneOwnershipIndex(index: OwnershipIndex, now: number): OwnershipIndex {
  const live = Object.entries(index).filter(
    ([, record]) => now - record.stagedAt <= OWNERSHIP_RETENTION_MS,
  );
  if (live.length <= MAX_OWNERSHIP_ENTRIES) {
    return Object.fromEntries(live);
  }
  // Oldest first: the registry keeps the newest entries when it overflows.
  live.sort(([, left], [, right]) => right.stagedAt - left.stagedAt);
  return Object.fromEntries(live.slice(0, MAX_OWNERSHIP_ENTRIES));
}

/** Writes the index atomically so a reader never observes a truncated registry. */
async function writeOwnershipIndex(index: OwnershipIndex): Promise<void> {
  const target = ownershipFilePath();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(index), { mode: OWNERSHIP_FILE_MODE });
  try {
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Serializes read-modify-write cycles. Concurrent tool results would otherwise
 * overwrite each other's records, and a lost record is an unenforceable reference.
 */
let ownershipQueue: Promise<unknown> = Promise.resolve();
function withOwnershipLock<T>(run: () => Promise<T>): Promise<T> {
  const next = ownershipQueue.then(run, run);
  ownershipQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function updateOwnership(
  id: string,
  apply: (existing: InboundMediaOwnership | undefined, now: number) => InboundMediaOwnership,
  options: { requireExisting?: boolean } = {},
): Promise<boolean> {
  if (!isSafeInboundMediaId(id)) {
    return false;
  }
  return await withOwnershipLock(async () => {
    try {
      const now = Date.now();
      const index = pruneOwnershipIndex(await readOwnershipIndex(), now);
      const existing = index[id];
      if (options.requireExisting && !existing) {
        // Binding is what narrows a published object. An object that was never staged
        // belongs to a lane this registry does not own, so it keeps its current access.
        return false;
      }
      index[id] = apply(existing, now);
      await writeOwnershipIndex(index);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Records that an object was staged, before any reference to it is attached.
 *
 * The staged marker alone already binds the object to a session: the route refuses an
 * object with a record unless the request resolves to a session. Reporting failure lets
 * the caller publish nothing rather than publish a reference the route cannot enforce.
 */
export async function recordStagedInboundMedia(id: string): Promise<boolean> {
  return await updateOwnership(id, (existing, now) => ({
    stagedAt: existing?.stagedAt ?? now,
    ...(existing?.sessionKey ? { sessionKey: existing.sessionKey } : {}),
    ...(existing?.agentId ? { agentId: existing.agentId } : {}),
  }));
}

/**
 * Records the originating session for a staged object, when the result that carries its
 * reference is persisted. Best-effort, and only for an object that was staged: the staged
 * marker already requires a session, and this narrows the object to the one session that
 * published it. A reference to an object this registry never staged is left alone, so an
 * unrelated lane such as a channel attachment keeps the access it has today.
 */
export async function recordInboundMediaOwner(
  id: string,
  owner: { sessionKey: string; agentId?: string },
): Promise<boolean> {
  if (!owner.sessionKey) {
    return false;
  }
  return await updateOwnership(
    id,
    (existing, now) => ({
      stagedAt: existing?.stagedAt ?? now,
      sessionKey: owner.sessionKey,
      ...((owner.agentId ?? existing?.agentId)
        ? { agentId: owner.agentId ?? existing?.agentId }
        : {}),
    }),
    { requireExisting: true },
  );
}

/** Reads the ownership record for an inbound id, or undefined when it is not staged. */
export async function resolveInboundMediaOwnership(
  id: string,
): Promise<InboundMediaOwnership | undefined> {
  if (!isSafeInboundMediaId(id)) {
    return undefined;
  }
  return (await readOwnershipIndex())[id];
}

function collectInboundMediaIdsFromValue(value: unknown, found: Set<string>, depth: number): void {
  if (depth > MAX_REFERENCE_WALK_DEPTH || found.size >= 32) {
    return;
  }
  if (typeof value === "string") {
    if (value.includes("media://inbound/")) {
      const id = inboundMediaIdFromReference(value);
      if (id) {
        found.add(id);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectInboundMediaIdsFromValue(entry, found, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  // SAFETY: value is confirmed a non-null, non-array object by the guard immediately above.
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectInboundMediaIdsFromValue(entry, found, depth + 1);
  }
}

/** Collects canonical inbound references anywhere inside a persisted session value. */
export function collectInboundMediaIds(value: unknown): string[] {
  const found = new Set<string>();
  collectInboundMediaIdsFromValue(value, found, 0);
  return [...found];
}

/**
 * Binds every staged reference inside a persisted value to the session that persisted it.
 * Returns the ids bound, so a caller can log or assert the binding without re-walking.
 */
export async function recordInboundMediaOwnersInValue(
  value: unknown,
  owner: { sessionKey: string; agentId?: string },
): Promise<string[]> {
  const ids = collectInboundMediaIds(value);
  const bound: string[] = [];
  for (const id of ids) {
    if (await recordInboundMediaOwner(id, owner)) {
      bound.push(id);
    }
  }
  return bound;
}
