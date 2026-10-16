import { registerNodeSqliteDisposeCallback } from "../../infra/kysely-sync-cache-state.js";
import { createSqliteQueryCache } from "../../infra/kysely-sync.js";
import { sqlPublicationAnchor, type EngineConnection } from "../../infra/sql-connection.js";
import { readSqliteDatabaseScopedWriteToken } from "../../infra/sqlite-database-admission.js";
import { hasUncommittedSqliteWrites } from "../../infra/sqlite-schema-facts.js";
import type { ContextEntry } from "./session-model-context-window.js";
import {
  createSessionTranscriptTreeScanner,
  scanSessionTranscriptTree,
} from "./transcript-tree.js";

/** Rewrites invalidate only the navigation page containing the changed row. */
const MODEL_CONTEXT_PAGE_SIZE = 512;

export function modelContextPageWriteScope(sessionId: string, seq: number): string {
  return JSON.stringify([
    "model-context-page",
    sessionId,
    Math.floor(seq / MODEL_CONTEXT_PAGE_SIZE),
  ]);
}

type ModelContextNavigationRow = {
  entry: ContextEntry;
  bytes: number;
  withoutCheckpointBytes: number;
};

type NavigationPage = {
  token: string | undefined;
  through: number;
};
type NavigationSnapshot = {
  sessionId: string;
  generation: string;
  pages: Map<number, NavigationPage>;
  rows: Map<number, ModelContextNavigationRow>;
  navigation?: {
    through: number;
    scanner: ReturnType<typeof createSessionTranscriptTreeScanner<ContextEntry>>;
  };
};

// The history connection retains its most recently read transcript's navigation,
// never bodies. Disposal releases it along with the owner's other read projections.
const navigationCache = createSqliteQueryCache((database) => {
  const cache: { snapshot?: NavigationSnapshot } = {};
  registerNodeSqliteDisposeCallback(sqlPublicationAnchor(database), () => {
    cache.snapshot = undefined;
  });
  return cache;
});

/** Append deltas and rewrite receipts share the existing transcript writer's settlement. */
export function readModelContextNavigationPages(params: {
  database: EngineConnection;
  sessionId: string;
  generation: string | null;
  through: number;
  readRows: (after: number, through: number) => Iterable<ModelContextNavigationRow>;
}) {
  const { database, sessionId, generation, through, readRows } = params;
  if (!generation || hasUncommittedSqliteWrites(database)) {
    const rows = new Map(Array.from(readRows(-1, through), (row) => [row.entry.seq, row]));
    return { rows, tree: scanSessionTranscriptTree(Array.from(rows.values(), (row) => row.entry)) };
  }
  const cache = navigationCache(database);
  let snapshot = cache.snapshot;
  if (snapshot?.sessionId !== sessionId || snapshot.generation !== generation) {
    snapshot = { sessionId, generation, pages: new Map(), rows: new Map() };
    cache.snapshot = snapshot;
  }
  const refresh: Array<{ after: number; through: number }> = [];
  for (let pageIndex = 0; pageIndex * MODEL_CONTEXT_PAGE_SIZE <= through; pageIndex += 1) {
    const start = pageIndex * MODEL_CONTEXT_PAGE_SIZE;
    const end = Math.min(start + MODEL_CONTEXT_PAGE_SIZE - 1, through);
    const token = readSqliteDatabaseScopedWriteToken(database, [
      modelContextPageWriteScope(sessionId, start),
    ]);
    let page = snapshot.pages.get(pageIndex);
    if (!page || token === undefined || page.token !== token) {
      page = { token, through: start - 1 };
      snapshot.pages.set(pageIndex, page);
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
  // Adjacent cold pages use one scan; ordinary appends read only their new suffix.
  for (const range of refresh) {
    for (const row of readRows(range.after, range.through)) {
      // Same-generation rewrites preserve navigation; only their model byte costs
      // can change. Keep the canonical scanner's committed entry references.
      row.entry = snapshot.rows.get(row.entry.seq)?.entry ?? row.entry;
      snapshot.rows.set(row.entry.seq, row);
    }
    for (
      let pageIndex = Math.floor((range.after + 1) / MODEL_CONTEXT_PAGE_SIZE);
      pageIndex * MODEL_CONTEXT_PAGE_SIZE <= range.through;
      pageIndex += 1
    ) {
      snapshot.pages.get(pageIndex)!.through = Math.min(
        (pageIndex + 1) * MODEL_CONTEXT_PAGE_SIZE - 1,
        range.through,
      );
    }
  }
  const rows = snapshot.rows;
  if (!snapshot.navigation || through < snapshot.navigation.through) {
    snapshot.navigation = {
      through: -1,
      scanner: createSessionTranscriptTreeScanner<ContextEntry>(),
    };
  }
  const navigation = snapshot.navigation;
  const tree = navigation.scanner.append(
    (function* () {
      for (let seq = navigation.through + 1; seq <= through; seq += 1) {
        const row = rows.get(seq);
        if (row) {
          yield row.entry;
        }
      }
    })(),
  );
  navigation.through = through;
  return { rows, tree };
}
