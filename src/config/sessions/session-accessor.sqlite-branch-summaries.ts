import type { Expression } from "kysely";
import {
  createSqliteQueryCache,
  prepareSqliteQueryIterator,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import type { SessionBranchSummary } from "./session-accessor.types.js";
import {
  extractSessionBranchHeadline,
  projectSessionBranchEntry,
  type SessionBranchTranscriptEntry,
} from "./session-message-cut-content.js";
import { transcriptEventJsonSql, transcriptEventNavigationSql } from "./transcript-payload.js";
import {
  isCanonicalSessionTranscriptEntry,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreeTipNodes,
  type SessionTranscriptTree,
} from "./transcript-tree.js";

type BranchTree = SessionTranscriptTree<SessionBranchTranscriptEntry | undefined>;
type HeadlineCandidate = { seq: number; previous: HeadlineCandidate | undefined };
type BranchPathSummary = { messageCount: number; candidate: HeadlineCandidate | undefined };
type SessionBranchSummaries = { branches: SessionBranchSummary[]; appendSafe: boolean };

type BranchQueryInput = { sessionId: string; seq: number };
type NavigationRow = { seq: number; event_json: string };

// Cache query plans, never rows; the snapshot owner supplies fresh session bindings.
const branchQueries = createSqliteQueryCache((database) => {
  const db = getSessionKysely(database);
  const navigation = (sessionId: Expression<string>) =>
    db
      .selectFrom("transcript_events")
      .select(["seq", transcriptEventNavigationSql(database).as("event_json")])
      .where("session_id", "=", sessionId)
      .orderBy("seq", "asc");
  return {
    headline: prepareSqliteQueryTakeFirstSync<BranchQueryInput, { event_json: string }>(
      database,
      (parameter) =>
        db
          .selectFrom("transcript_events")
          .select(transcriptEventJsonSql(database).as("event_json"))
          .where(
            "session_id",
            "=",
            parameter((input) => input.sessionId),
          )
          .where(
            "seq",
            "=",
            parameter((input) => input.seq),
          )
          .limit(1),
    ),
    tail: prepareSqliteQueryIterator<
      BranchQueryInput,
      NavigationRow & { identity_id: string | null }
    >(database, (parameter) => {
      const sessionId = parameter((input) => input.sessionId);
      return navigation(sessionId)
        .where(
          "seq",
          ">",
          parameter((input) => input.seq),
        )
        .select((eb) =>
          eb
            .selectFrom("transcript_event_identities")
            .select("event_id")
            .where("session_id", "=", sessionId)
            .whereRef("seq", "=", "transcript_events.seq")
            .limit(1)
            .as("identity_id"),
        );
    }),
    all: prepareSqliteQueryIterator<string, NavigationRow & { identity_count: number }>(
      database,
      (parameter) => {
        const sessionId = parameter((value) => value);
        return navigation(sessionId).select((eb) =>
          eb
            .selectFrom("transcript_event_identities")
            .select((identity) => identity.fn.countAll<number>().as("count"))
            .where("session_id", "=", sessionId)
            .as("identity_count"),
        );
      },
    ),
  };
});

/** Read navigation and selected headlines inside the branch snapshot owner's transaction. */
export function readSessionBranchSummaries(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  previous?: { branches: SessionBranchSummary[]; appendSafe?: boolean; maxSeq: number | null },
): SessionBranchSummaries {
  const queries = branchQueries(database.db);
  const readHeadline = (seq: number) => {
    const row = queries.headline({ sessionId, seq });
    if (!row) {
      throw new Error("Branch headline row is missing from the transcript snapshot");
    }
    return extractSessionBranchHeadline(JSON.parse(row.event_json));
  };
  const active = previous?.branches.find((branch) => branch.active);
  if (previous?.appendSafe && previous.maxSeq !== null && active) {
    let tail = { ...active };
    let candidate: HeadlineCandidate | undefined;
    let appendSafe = true;
    for (const row of queries.tail({ sessionId, seq: previous.maxSeq })) {
      const entry = projectSessionBranchEntry(JSON.parse(row.event_json), row.seq);
      // Identity ownership rules out duplicate IDs in the certified prefix or suffix.
      if (
        !isCanonicalSessionTranscriptEntry(entry) ||
        entry.appendMode === "side" ||
        entry.id !== row.identity_id ||
        typeof entry.id !== "string" ||
        entry.id.trim() !== entry.id ||
        entry.parentId !== tail.leafEntryId
      ) {
        appendSafe = false;
        break;
      }
      if (entry.headlineCandidate) {
        candidate = { seq: row.seq, previous: candidate };
      }
      tail = {
        leafEntryId: entry.id,
        headline: tail.headline,
        messageCount: tail.messageCount + Number(entry.type === "message"),
        ...(typeof entry.timestamp === "string" ? { updatedAt: entry.timestamp } : {}),
        active: true,
      };
    }
    if (appendSafe) {
      tail.headline = resolveBranchHeadline(candidate, new Map(), readHeadline) || tail.headline;
      return {
        branches: [tail, ...previous.branches.filter((branch) => !branch.active)],
        appendSafe,
      };
    }
  }
  let appendSafe = true;
  let navigationCount = 0;
  let identityCount: number | null = 0;
  function* navigationEntries() {
    for (const row of queries.all(sessionId)) {
      navigationCount++;
      identityCount = row.identity_count;
      const entry = projectSessionBranchEntry(JSON.parse(row.event_json), row.seq);
      appendSafe &&=
        typeof entry?.id === "string" && entry.id.length > 0 && entry.id.trim() === entry.id;
      yield entry;
    }
  }
  // Finish parsing every row before accepting any headline, including malformed unused tails.
  const tree = scanSessionTranscriptTree(navigationEntries());
  // Missing/forward parents can change old paths when a later append supplies their ID.
  // Writers preserve identity membership; counting once also excludes legacy unindexed rows.
  appendSafe &&=
    identityCount === navigationCount &&
    !tree.hasInvalidLeafControl &&
    tree.nodes.length === tree.byId.size &&
    tree.nodes.every(
      (node) =>
        node.parentId === null || (tree.byId.get(node.parentId)?.index ?? Infinity) < node.index,
    );
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
  return { branches, appendSafe };
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
