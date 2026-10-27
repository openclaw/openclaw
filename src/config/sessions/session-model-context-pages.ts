import type { AgentMessage } from "@openclaw/agent-core";
import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import { createSqliteQueryCache } from "../../infra/kysely-sync.js";
import { sqlPublicationAnchor, type EngineConnection } from "../../infra/sql-connection.js";
import {
  readSqliteDatabaseScopedWriteToken,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { hasUncommittedSqliteWrites } from "../../infra/sqlite-schema-facts.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import { createModelContextPairing } from "./session-model-context-pairing.js";
import { collectSessionModelContextRequests } from "./session-model-context-read.js";
import type { ContextEntry, ModelContextRequest } from "./session-model-context-window.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** Rewrites invalidate only the navigation page containing the changed row. */
const MODEL_CONTEXT_PAGE_SIZE = 512;

export function modelContextPageWriteScope(
  sessionId: string,
  seq: number,
): { sessionId: string; partition: string } {
  return {
    ...sqliteSessionIdWriteScope(sessionId),
    partition: `model-context-page:${Math.floor(seq / MODEL_CONTEXT_PAGE_SIZE)}`,
  };
}

type ModelContextNavigationRow = {
  entry: ContextEntry;
  bytes: number;
  withoutCheckpointBytes: number;
};
type NavigationPage = {
  token: string | undefined;
  through: number;
  // One byte per discarded raw row records canonical membership and checkpoint omission.
  // Rewrites can refresh exact prefix costs from their existing page receipt.
  membership?: Uint8Array;
  bytes: number;
};
type NavigationSnapshot = {
  sessionId: string;
  generation: string;
  through: number;
  maxEvents: number;
  anchorId?: string;
  leafId: string | null;
  appendParentId: string | null;
  pages: Map<number, NavigationPage>;
  rows: Map<number, ModelContextNavigationRow>;
  requests: ModelContextRequest[];
  entries: ContextEntry[];
  model?: ContextEntry;
  thinking?: ContextEntry;
  prefixCount: number;
  prefixBytes: number;
  prefixHasUser: boolean;
  pairing: ReturnType<typeof createModelContextPairing>;
};

const navigationCache = createSqliteQueryCache((database) => {
  const cache: { snapshot?: NavigationSnapshot } = {};
  registerNodeSqliteDisposeCallback(sqlPublicationAnchor(database), () => {
    cache.snapshot = undefined;
  });
  return cache;
});

function messages(requests: readonly ModelContextRequest[]): AgentMessage[] {
  return requests.flatMap(({ entry }) => (entry.type === "message" ? [entry.message] : []));
}

function rowBytes(row: ModelContextNavigationRow, omitCheckpoint: boolean): number {
  return omitCheckpoint ? row.withoutCheckpointBytes : row.bytes;
}

function rebuildEntries(snapshot: NavigationSnapshot): void {
  const entries = new Map(snapshot.requests.map(({ entry }) => [entry.seq, entry]));
  if (snapshot.model) {
    entries.set(snapshot.model.seq, snapshot.model);
  }
  if (snapshot.thinking) {
    entries.set(snapshot.thinking.seq, snapshot.thinking);
  }
  snapshot.entries = [...entries.values()].toSorted((a, b) => a.seq - b.seq);
}

function trimRequests(snapshot: NavigationSnapshot): void {
  const boundary = snapshot.requests.find(
    ({ entry }) => entry.type === "compaction" || entry.type === "reset",
  );
  const candidates = snapshot.requests.filter((request) => request !== boundary);
  const removed = candidates.splice(0, Math.max(0, candidates.length - snapshot.maxEvents));
  for (const request of removed) {
    const { entry, omitCheckpoint } = request;
    const page = snapshot.pages.get(Math.floor(entry.seq / MODEL_CONTEXT_PAGE_SIZE))!;
    const bytes = rowBytes(snapshot.rows.get(entry.seq)!, omitCheckpoint);
    (page.membership ??= new Uint8Array(MODEL_CONTEXT_PAGE_SIZE))[
      entry.seq % MODEL_CONTEXT_PAGE_SIZE
    ] = omitCheckpoint ? 2 : 1;
    page.bytes += bytes;
    snapshot.prefixCount += 1;
    snapshot.prefixHasUser ||= entry.type === "message" && entry.message.role === "user";
    snapshot.prefixBytes += bytes;
    snapshot.rows.delete(entry.seq);
  }
  snapshot.requests = boundary ? [boundary, ...candidates] : candidates;
  snapshot.pairing.retain(messages(snapshot.requests));
  rebuildEntries(snapshot);
}

/** A normal append continues the known cursor; other topology is canonically reseeded. */
function appendRows(snapshot: NavigationSnapshot, rows: ModelContextNavigationRow[]): boolean {
  if (rows.length === 0) {
    return true;
  }
  let leafId = snapshot.leafId;
  let appendParentId = snapshot.appendParentId;
  const entries: ContextEntry[] = [];
  for (const row of rows) {
    const entry = row.entry;
    if (
      ![
        "message",
        "thinking_level_change",
        "model_change",
        "custom",
        "custom_message",
        "label",
        "session_info",
      ].includes(entry.type) ||
      (entry.type === "custom" &&
        entry.customType === "openclaw.system-prompt" &&
        typeof entry.data === "object" &&
        entry.data !== null &&
        "restart" in entry.data &&
        entry.data.restart === true) ||
      ("appendMode" in entry && entry.appendMode === "side") ||
      (Object.hasOwn(entry, "parentId") &&
        entry.parentId !== leafId &&
        entry.parentId !== appendParentId)
    ) {
      return false;
    }
    const normalized = entry.parentId === leafId ? entry : { ...entry, parentId: leafId };
    entries.push(normalized);
    leafId = entry.id;
    appendParentId = entry.id;
  }
  if (!snapshot.pairing.append(messages(collectSessionModelContextRequests(entries)))) {
    return false;
  }
  for (const [index, entry] of entries.entries()) {
    if (
      entry.type === "model_change" ||
      (entry.type === "message" && entry.message.role === "assistant")
    ) {
      snapshot.model = entry;
    }
    if (entry.type === "thinking_level_change") {
      snapshot.thinking = entry;
    }
    const requests = collectSessionModelContextRequests([entry]);
    snapshot.requests.push(...requests);
    if (requests.length) {
      snapshot.rows.set(entry.seq, { ...rows[index]!, entry });
    }
  }
  snapshot.leafId = leafId;
  snapshot.appendParentId = appendParentId;
  trimRequests(snapshot);
  return true;
}

/** Retain only a selectable suffix; prefix membership and costs advance with committed deltas. */
export function readModelContextNavigationPages(params: {
  database: EngineConnection;
  sessionId: string;
  generation: string | null;
  through: number;
  anchorId?: string;
  maxEvents?: number;
  readRows: (after: number, through: number) => Iterable<ModelContextNavigationRow>;
}) {
  const { database, sessionId, generation, through, anchorId, maxEvents, readRows } = params;
  const cache = navigationCache(database);
  const cacheable =
    generation !== null &&
    maxEvents !== undefined &&
    !hasUncommittedSqliteWrites(database) &&
    // A historical read must not evict the current branch's warmed prefix facts.
    (anchorId === undefined ||
      cache.snapshot?.sessionId !== sessionId ||
      cache.snapshot.anchorId !== undefined);
  let snapshot = cacheable ? cache.snapshot : undefined;
  if (
    snapshot?.sessionId !== sessionId ||
    snapshot.generation !== generation ||
    (maxEvents !== undefined && snapshot.maxEvents < maxEvents) ||
    snapshot.anchorId !== anchorId ||
    through < snapshot.through ||
    (anchorId !== undefined && anchorId !== snapshot.leafId)
  ) {
    snapshot = undefined;
  }
  const pages = snapshot?.pages ?? new Map<number, NavigationPage>();
  const refresh: Array<{ after: number; through: number }> = [];
  for (let pageIndex = 0; pageIndex * MODEL_CONTEXT_PAGE_SIZE <= through; pageIndex += 1) {
    const start = pageIndex * MODEL_CONTEXT_PAGE_SIZE;
    const end = Math.min(start + MODEL_CONTEXT_PAGE_SIZE - 1, through);
    const token = cacheable
      ? readSqliteDatabaseScopedWriteToken(database, [modelContextPageWriteScope(sessionId, start)])
      : undefined;
    let page = pages.get(pageIndex);
    if (!page) {
      page = { token, through: start - 1, bytes: 0 };
      pages.set(pageIndex, page);
    } else if (token === undefined || page.token !== token) {
      page.token = token;
      page.through = start - 1;
    }
    if (page.through < end) {
      const previous = refresh.at(-1);
      if (previous?.through === page.through) {
        previous.through = end;
      } else {
        refresh.push({ after: page.through, through: end });
      }
    }
  }
  if (snapshot) {
    const appended: ModelContextNavigationRow[] = [];
    for (const range of refresh) {
      const prefixBytes = new Map<number, number>();
      for (const row of readRows(range.after, range.through)) {
        if (row.entry.seq > snapshot.through) {
          appended.push(row);
        } else {
          const retained = snapshot.rows.get(row.entry.seq);
          if (retained) {
            snapshot.rows.set(row.entry.seq, { ...row, entry: retained.entry });
          }
        }
        const pageIndex = Math.floor(row.entry.seq / MODEL_CONTEXT_PAGE_SIZE);
        const flags =
          pages.get(pageIndex)!.membership?.[row.entry.seq % MODEL_CONTEXT_PAGE_SIZE] ?? 0;
        if (flags) {
          const bytes = rowBytes(row, (flags & 2) !== 0);
          prefixBytes.set(pageIndex, (prefixBytes.get(pageIndex) ?? 0) + bytes);
        }
      }
      for (const [pageIndex, bytes] of prefixBytes) {
        const page = pages.get(pageIndex)!;
        snapshot.prefixBytes += bytes - page.bytes;
        page.bytes = bytes;
      }
    }
    if (appendRows(snapshot, appended)) {
      snapshot.through = through;
      for (const [pageIndex, page] of pages) {
        page.through = Math.min((pageIndex + 1) * MODEL_CONTEXT_PAGE_SIZE - 1, through);
      }
      return {
        rows: snapshot.rows,
        entries: snapshot.entries,
        anchorFound: true,
        prepared: {
          requests: snapshot.requests,
          prefix: {
            count: snapshot.prefixCount,
            bytes: snapshot.prefixBytes,
            hasUser: snapshot.prefixHasUser,
            pairing: snapshot.pairing.read(),
          },
        },
      };
    }
  }
  // Old anchors, branch/reset/compaction or prompt-series restarts and displaced results need
  // canonical ancestry once. The resulting compact state serves subsequent ordinary reads.
  const rows = new Map(Array.from(readRows(-1, through), (row) => [row.entry.seq, row]));
  const tree = scanSessionTranscriptTree(Array.from(rows.values(), (row) => row.entry));
  const branch = selectSessionTranscriptTreePathNodes(tree, anchorId ?? tree.leafId).map(
    ({ entry, parentId }) => {
      entry.parentId = parentId;
      return entry;
    },
  );
  const entries = normalizeSessionContextEntryBoundaries(branch, tree.nodes);
  const anchorFound = anchorId === undefined || tree.byId.has(anchorId);
  if (cacheable && anchorFound) {
    for (const [pageIndex, page] of pages) {
      page.through = Math.min((pageIndex + 1) * MODEL_CONTEXT_PAGE_SIZE - 1, through);
      page.membership = undefined;
      page.bytes = 0;
    }
    const requests = collectSessionModelContextRequests(entries);
    snapshot = {
      sessionId,
      generation,
      through,
      maxEvents,
      anchorId,
      leafId: anchorId ?? tree.leafId,
      appendParentId: tree.appendParentId,
      pages,
      rows: new Map(requests.map(({ entry }) => [entry.seq, rows.get(entry.seq)!])),
      requests,
      entries: [],
      prefixCount: 0,
      prefixBytes: 0,
      prefixHasUser: false,
      model: entries.findLast(
        (entry) =>
          entry.type === "model_change" ||
          (entry.type === "message" && entry.message.role === "assistant"),
      ),
      thinking: entries.findLast((entry) => entry.type === "thinking_level_change"),
      pairing: createModelContextPairing(messages(requests), messages(requests.slice(-maxEvents))),
    };
    trimRequests(snapshot);
    cache.snapshot = snapshot;
  }
  return { rows, entries, anchorFound, prepared: undefined };
}
