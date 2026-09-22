import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionEntry,
  SessionEntryBase,
} from "../../agents/sessions/session-manager-types.js";
import {
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-entry-codec.js";
import {
  isSessionTranscriptSideAppendEntry,
  type SessionTranscriptTreeNode,
} from "./transcript-tree.js";

export type SessionNavigationEntry = Pick<SessionEntryBase, "id" | "parentId"> & {
  timestamp?: string;
  appendMode?: unknown;
} & (
    | { type: "label"; targetId: string; label?: string }
    | { type: Exclude<SessionEntry["type"], "label"> }
  );

type SessionParentEntry = Pick<SessionEntryBase, "id" | "parentId">;

function resolveSessionCanonicalParentId(
  parentId: string | null,
  byId: ReadonlyMap<string, SessionParentEntry>,
  opaqueParentsById: ReadonlyMap<string, string | null>,
): string | null {
  let seen: Set<string> | undefined;
  let currentId = parentId;
  while (currentId && !byId.has(currentId)) {
    if (seen?.has(currentId)) {
      return null;
    }
    (seen ??= new Set()).add(currentId);
    currentId = opaqueParentsById.get(currentId) ?? null;
  }
  return currentId;
}

/** Opaque keep markers retain the same canonical ancestry as session replay. */
export function resolveOpaqueSessionFirstKeptEntryId(params: {
  firstKeptEntryId: string;
  parentId: string | null;
  fallbackParentId: string | null;
  byId: ReadonlyMap<string, SessionParentEntry>;
  opaqueParentsById: ReadonlyMap<string, string | null>;
  entries: () => Iterable<SessionParentEntry>;
}): string | undefined {
  const { firstKeptEntryId, byId, opaqueParentsById } = params;
  const parent = resolveSessionCanonicalParentId(firstKeptEntryId, byId, opaqueParentsById);
  if (parent !== null) {
    return parent;
  }
  const seen = new Set<string>();
  let currentId = params.parentId;
  let firstCanonicalDescendant: string | undefined;
  while (currentId && !seen.has(currentId)) {
    if (currentId === firstKeptEntryId) {
      if (firstCanonicalDescendant) {
        return firstCanonicalDescendant;
      }
      break;
    }
    seen.add(currentId);
    const entry = byId.get(currentId);
    if (entry) {
      firstCanonicalDescendant = entry.id;
      currentId = entry.parentId;
    } else {
      currentId = opaqueParentsById.get(currentId) ?? null;
    }
  }
  for (const entry of params.entries()) {
    const ancestors = new Set<string>();
    let parentId = entry.parentId;
    while (parentId && opaqueParentsById.has(parentId) && !ancestors.has(parentId)) {
      if (parentId === firstKeptEntryId) {
        return entry.id;
      }
      ancestors.add(parentId);
      parentId = opaqueParentsById.get(parentId) ?? null;
    }
  }
  return params.fallbackParentId ?? undefined;
}

/** Normalize selected branch boundaries before choosing or hydrating model context. */
export function normalizeSessionContextEntryBoundaries<T>(
  entries: readonly T[],
  navigation: readonly SessionTranscriptTreeNode<unknown>[],
): T[] {
  if (
    !entries.some(
      (entry) =>
        isRecord(entry) &&
        (entry.type === "compaction" || entry.type === "reset") &&
        typeof entry.firstKeptEntryId === "string",
    )
  ) {
    return entries.slice();
  }
  const byId = new Map<string, SessionParentEntry>();
  const opaqueParentsById = new Map<string, string | null>();
  for (const node of navigation) {
    if (isIndexedSessionEntry(node.entry)) {
      byId.set(node.id, { id: node.id, parentId: node.parentId });
    } else {
      opaqueParentsById.set(node.id, node.parentId);
    }
  }
  return entries.map((entry) => {
    if (
      !isIndexedSessionEntry(entry) ||
      (entry.type !== "compaction" && entry.type !== "reset") ||
      entry.firstKeptEntryId === undefined ||
      byId.has(entry.firstKeptEntryId) ||
      !opaqueParentsById.has(entry.firstKeptEntryId)
    ) {
      return entry;
    }
    const parentId = resolveSessionCanonicalParentId(entry.parentId, byId, opaqueParentsById);
    const firstKeptEntryId = resolveOpaqueSessionFirstKeptEntryId({
      firstKeptEntryId: entry.firstKeptEntryId,
      parentId,
      fallbackParentId: parentId,
      byId,
      opaqueParentsById,
      entries: () => byId.values(),
    });
    return firstKeptEntryId ? { ...entry, firstKeptEntryId } : entry;
  });
}

/** One navigation owner for runtime sessions and streaming transcript operations. */
export class SessionEntryNavigation<T extends SessionNavigationEntry> {
  protected byId = new Map<string, T>();
  protected opaqueParentsById = new Map<string, string | null>();
  protected logicalParentsById = new Map<string, string | null>();
  protected invalidLeafControlIds = new Set<string>();
  protected labelsById = new Map<string, string>();
  protected labelTimestampsById = new Map<string, T["timestamp"]>();
  protected leafId: string | null = null;
  protected appendParentId: string | null = null;
  protected appendMode: "side" | undefined;
  private latestResetId: string | undefined;
  private resetDescendantIds = new Set<string>();

  protected clearNavigation(): void {
    this.byId.clear();
    this.opaqueParentsById.clear();
    this.logicalParentsById.clear();
    this.invalidLeafControlIds.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.appendParentId = null;
    this.appendMode = undefined;
    this.latestResetId = undefined;
    this.resetDescendantIds.clear();
  }

  protected finishNavigation(): void {
    // These are scan-local facts; retained managers only need the finished maps.
    this.latestResetId = undefined;
    this.resetDescendantIds.clear();
  }

  protected resolveOpaqueLeafTargetId(targetId: string | null): string | null {
    if (targetId === null || this.byId.has(targetId)) {
      return targetId;
    }
    return this.resolveCanonicalParentId(targetId);
  }

  protected resolveOpaqueAppendParentId(parentId: string | null): string | null {
    if (parentId === null || this.byId.has(parentId) || this.opaqueParentsById.has(parentId)) {
      return parentId;
    }
    return this.resolveCanonicalParentId(parentId);
  }

  protected resolveOpaqueLeafControl(
    leafEntry: ReturnType<typeof parseOpaqueLeafEntry>,
  ): { leafId: string | null; appendParentId: string | null; appendMode?: "side" } | undefined {
    if (!leafEntry) {
      return undefined;
    }
    const isKnownReference = (id: string | null): boolean =>
      id === null ||
      this.byId.has(id) ||
      (this.opaqueParentsById.has(id) && !this.invalidLeafControlIds.has(id));
    if (
      !isKnownReference(leafEntry.targetId) ||
      (leafEntry.appendParentId !== undefined && !isKnownReference(leafEntry.appendParentId))
    ) {
      return undefined;
    }
    const leafId = this.resolveOpaqueLeafTargetId(leafEntry.targetId);
    return {
      leafId,
      appendParentId:
        leafEntry.appendParentId === undefined
          ? leafId
          : this.resolveOpaqueAppendParentId(leafEntry.appendParentId),
      ...(leafEntry.appendMode ? { appendMode: leafEntry.appendMode } : {}),
    };
  }

  protected appendOpaqueNavigationRecord(opaqueRecord: unknown): void {
    const leafEntry = parseOpaqueLeafEntry(opaqueRecord);
    if (leafEntry) {
      const leafState = this.resolveOpaqueLeafControl(leafEntry);
      if (!leafState) {
        this.invalidLeafControlIds.add(leafEntry.id);
        this.opaqueParentsById.set(
          leafEntry.id,
          this.resolveOpaqueAppendParentId(leafEntry.parentId),
        );
        return;
      }
      const crossesResetBoundary =
        this.latestResetId !== undefined &&
        (leafState.leafId === null || !this.resetDescendantIds.has(leafState.leafId));
      const effectiveLeafState: typeof leafState = crossesResetBoundary
        ? { leafId: this.leafId, appendParentId: this.leafId }
        : leafState;
      this.opaqueParentsById.set(leafEntry.id, effectiveLeafState.leafId);
      if (
        this.latestResetId !== undefined &&
        effectiveLeafState.leafId !== null &&
        this.resetDescendantIds.has(effectiveLeafState.leafId)
      ) {
        this.resetDescendantIds.add(leafEntry.id);
      }
      this.leafId = effectiveLeafState.leafId;
      this.appendParentId = effectiveLeafState.appendParentId;
      this.appendMode = effectiveLeafState.appendMode;
      return;
    }
    const link = parseParentLinkedOpaqueEntry(opaqueRecord);
    if (link) {
      this.opaqueParentsById.set(link.id, link.parentId);
      if (
        this.latestResetId !== undefined &&
        link.parentId !== null &&
        this.resetDescendantIds.has(link.parentId)
      ) {
        this.resetDescendantIds.add(link.id);
      }
      this.appendParentId = link.id;
    }
  }

  protected appendCanonicalNavigationEntry(
    entry: T,
    hasParentId = Object.hasOwn(entry, "parentId"),
  ): void {
    if (entry.type === "label" && !this.byId.has(entry.targetId)) {
      this.opaqueParentsById.set(entry.id, this.resolveCanonicalParentId(entry.parentId));
      return;
    }
    const crossesResetBoundary =
      this.latestResetId !== undefined &&
      !isSessionTranscriptSideAppendEntry(entry) &&
      (entry.parentId === null || !this.resetDescendantIds.has(entry.parentId));
    if (
      crossesResetBoundary ||
      !hasParentId ||
      (!isSessionTranscriptSideAppendEntry(entry) &&
        entry.parentId === this.appendParentId &&
        this.leafId !== this.appendParentId)
    ) {
      this.logicalParentsById.set(entry.id, this.leafId);
    }
    this.byId.set(entry.id, entry);
    if (entry.type === "reset") {
      this.latestResetId = entry.id;
      this.resetDescendantIds.clear();
      this.resetDescendantIds.add(entry.id);
    } else {
      const logicalParentId = this.logicalParentsById.has(entry.id)
        ? (this.logicalParentsById.get(entry.id) ?? null)
        : entry.parentId;
      if (
        this.latestResetId !== undefined &&
        logicalParentId !== null &&
        this.resetDescendantIds.has(logicalParentId)
      ) {
        this.resetDescendantIds.add(entry.id);
      }
    }
    this.appendParentId = entry.id;
    if (isSessionTranscriptSideAppendEntry(entry)) {
      this.appendMode = "side";
    } else {
      this.leafId = entry.id;
      this.appendMode = undefined;
    }
    if (entry.type === "label") {
      if (entry.label) {
        this.labelsById.set(entry.targetId, entry.label);
        this.labelTimestampsById.set(entry.targetId, entry.timestamp);
      } else {
        this.labelsById.delete(entry.targetId);
        this.labelTimestampsById.delete(entry.targetId);
      }
    }
  }

  protected resolveCanonicalParentId(parentId: string | null): string | null {
    return resolveSessionCanonicalParentId(parentId, this.byId, this.opaqueParentsById);
  }

  protected resolveEntryParentId(entry: T): string | null {
    return this.logicalParentsById.has(entry.id)
      ? (this.logicalParentsById.get(entry.id) ?? null)
      : this.resolveCanonicalParentId(entry.parentId);
  }

  protected normalizeEntryParent(entry: T): T {
    const parentId = this.resolveEntryParentId(entry);
    let normalized = parentId === entry.parentId ? entry : { ...entry, parentId };
    if (normalized.parentId === normalized.id) {
      normalized = { ...normalized, parentId: null };
    }
    return normalized;
  }

  getBranch(fromId?: string): T[] {
    const path: T[] = [];
    const seen = new Set<string>();
    let currentId = fromId ?? this.leafId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const current = this.byId.get(currentId);
      if (current) {
        const normalizedCurrent = this.normalizeEntryParent(current);
        path.push(normalizedCurrent);
        currentId = normalizedCurrent.parentId;
      } else {
        currentId = this.opaqueParentsById.get(currentId) ?? null;
      }
    }
    path.reverse();
    return path;
  }
}
