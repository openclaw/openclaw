import { iterateSqliteQuerySync, prepareSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import {
  extractSessionBranchHeadline,
  projectSessionBranchEntry,
  type SessionBranchTranscriptEntry,
} from "./session-message-cut-content.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreeTipNodes,
  type SessionTranscriptTree,
} from "./transcript-tree.js";

type BranchTree = SessionTranscriptTree<SessionBranchTranscriptEntry | undefined>;
type HeadlineCandidate = { seq: number; previous: HeadlineCandidate | undefined };
type BranchPathSummary = { messageCount: number; candidate: HeadlineCandidate | undefined };

/** Retain navigation, then read only the headline candidates needed by the final graph. */
export function readSessionBranchSummaries(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): SessionBranchSummary[] {
  return readHotSessionTranscriptSnapshot(database, sessionId, "events", () => {
    const db = getSessionKysely(database.db);
    const rows = iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(["seq", "event_json"])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    );
    function* navigationEntries() {
      for (const row of rows) {
        yield projectSessionBranchEntry(JSON.parse(row.event_json), row.seq);
      }
    }
    // Finish parsing every row before accepting any headline, including malformed unused tails.
    const tree = scanSessionTranscriptTree(navigationEntries());
    const readCandidate = prepareSqliteQuerySync<number, { event_json: string }>(
      database.db,
      (parameter) =>
        db
          .selectFrom("transcript_events")
          .select("event_json")
          .where("session_id", "=", sessionId)
          .where(
            "seq",
            "=",
            parameter((seq) => seq),
          )
          .limit(1),
    );
    const readHeadline = (seq: number) => {
      const row = readCandidate(seq).rows[0];
      if (!row) {
        throw new Error("Branch headline row is missing from the transcript snapshot");
      }
      return extractSessionBranchHeadline(JSON.parse(row.event_json));
    };
    const paths = new Map<string, BranchPathSummary>();
    const headlines = new Map<HeadlineCandidate, string | undefined>();
    const branches: SessionBranchSummary[] = [];
    for (const node of selectSessionTranscriptTreeTipNodes(tree).toSorted(
      (left, right) =>
        Number(right.id === tree.leafId) - Number(left.id === tree.leafId) ||
        right.index - left.index,
    )) {
      // SAFETY: The scanner inserts every returned node into its final byId map.
      const leaf = tree.byId.get(node.id)!;
      const summary = summarizeBranchPath(tree, leaf, paths);
      const timestamp = leaf.entry?.timestamp;
      branches.push({
        leafEntryId: leaf.id,
        headline: resolveBranchHeadline(summary?.candidate, headlines, readHeadline),
        messageCount: summary?.messageCount ?? 0,
        ...(typeof timestamp === "string" && timestamp.trim() ? { updatedAt: timestamp } : {}),
        active: tree.leafId === leaf.id,
      });
    }
    return branches;
  });
}

function summarizeBranchPath(
  tree: BranchTree,
  leaf: BranchTree["nodes"][number],
  summaries: Map<string, BranchPathSummary>,
): BranchPathSummary | undefined {
  const uncachedPath: typeof tree.nodes = [];
  const seen = new Set<string>();
  let current = leaf;
  // Count and validate the complete path before a nearby headline can end text lookup.
  while (!summaries.has(current.id)) {
    if (seen.has(current.id)) {
      uncachedPath.length = 0;
      break;
    }
    seen.add(current.id);
    uncachedPath.push(current);
    const parent = current.parentId === null ? undefined : tree.byId.get(current.parentId);
    if (!parent) {
      break;
    }
    current = parent;
  }

  let summary = summaries.get(current.id);
  for (const node of uncachedPath.toReversed()) {
    const entry = node.entry;
    summary = {
      messageCount: (summary?.messageCount ?? 0) + (entry?.type === "message" ? 1 : 0),
      candidate: entry?.headlineCandidate
        ? { seq: entry.seq, previous: summary?.candidate }
        : summary?.candidate,
    };
    summaries.set(node.id, summary);
  }
  return summary;
}

function resolveBranchHeadline(
  candidate: HeadlineCandidate | undefined,
  headlines: Map<HeadlineCandidate, string | undefined>,
  read: (seq: number) => string | undefined,
): string {
  const unresolved: HeadlineCandidate[] = [];
  let headline: string | undefined;
  let current = candidate;
  while (current) {
    if (headlines.has(current)) {
      headline = headlines.get(current);
      break;
    }
    unresolved.push(current);
    headline = read(current.seq);
    if (headline !== undefined) {
      break;
    }
    current = current.previous;
  }
  for (const entry of unresolved) {
    headlines.set(entry, headline);
  }
  return headline ?? "";
}
