import { createRetainedCache } from "../infra/retained-cache.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getOrCreateWeakOwnerMap } from "../shared/weak-owner-map.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type { TaskPublicationRead } from "../state/github-publication-task-reads.worker.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import type { ControlUiSessionTaskPullRequest } from "./control-ui-contract.js";
import { SessionRowFactsPending } from "./session-row-prepared-read.js";
import { hasEntry, type EntryRow, type Lookup, type Row } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

type PublicationNode = {
  query: Lookup;
  identity: string;
  session: TaskPublicationRead["sessions"][number];
  children?: PublicationNode[];
};
type PublicationRow = Pick<EntryRow, "agentId" | "key" | "storeTarget" | "generation"> & {
  entry: Pick<EntryRow["entry"], "sessionId" | "lifecycleRevision">;
};
// Lineage revisions own structural facts, never a viewer's permission to consume them.
const nodesByRevision = new WeakMap<object, Map<EntryRow["generation"], PublicationNode>>();
// Display rows retire with sharing publications, independently of long-lived lineage.
const rowsByRevision = new WeakMap<object, Map<PublicationNode, Row>>();

function readPublicationRow(
  projection: SessionRowProjection,
  node: PublicationNode,
  rows: Map<PublicationNode, Row> | undefined,
) {
  let row = rows?.get(node);
  if (!row) {
    row = projection.capture(node.query);
    if (row) {
      rows?.set(node, row);
    }
  }
  if (row && (row.sharingEntry !== row.storedEntry || row.entryAcquisitionPending)) {
    throw new SessionRowFactsPending([node.query]);
  }
  return row;
}

function allowsPublicationRow(
  row: Row | undefined,
  allows: (row: EntryRow) => boolean,
): row is EntryRow {
  return hasEntry(row) && !row.entry.incognito && !isIncognitoSessionKey(row.key) && allows(row);
}

/** Traverse the row owner's indexed lineage; neither checkout nor transcript is evidence. */
function selectTaskPublicationSessions(
  projection: SessionRowProjection,
  root: PublicationRow,
  allows: (row: EntryRow) => boolean,
) {
  // Registry publications can defer parent-index updates until row preparation.
  void projection.state;
  const revision = projection.readTaskPublicationRevision();
  const nodes = getOrCreateWeakOwnerMap(nodesByRevision, revision);
  const sharing = projection.sharingRevision;
  const rows = sharing ? getOrCreateWeakOwnerMap(rowsByRevision, sharing) : undefined;
  const prepare = (row: PublicationRow): PublicationNode => {
    const retained = nodes.get(row.generation);
    if (retained) {
      return retained;
    }
    const node: PublicationNode = {
      query: { agentId: row.agentId, key: row.key, storePath: row.storeTarget.storePath },
      identity: JSON.stringify([row.agentId, row.key, row.entry.sessionId]),
      session: {
        agentId: row.agentId,
        sessionKey: row.key,
        sessionId: row.entry.sessionId,
        lifecycleRevision: row.entry.lifecycleRevision ?? null,
      },
    };
    nodes.set(row.generation, node);
    return node;
  };
  const seen = new Set<string>();
  const pending = [prepare(root)];
  const sessions: TaskPublicationRead["sessions"] = [];
  const visits: Array<{ node: PublicationNode; duplicate: boolean; included: boolean }> = [];
  for (const node of pending) {
    const { identity } = node;
    const row = readPublicationRow(projection, node, rows);
    const duplicate = seen.has(identity);
    const included = !duplicate && allowsPublicationRow(row, allows);
    visits.push({ node, duplicate, included });
    if (!included) {
      continue;
    }
    seen.add(identity);
    sessions.push(node.session);
    node.children ??= projection.selectEntries({ parentSessionKey: row }).map(prepare);
    pending.push(...node.children);
  }
  sessions.sort(
    (a, b) => a.sessionKey.localeCompare(b.sessionKey) || a.agentId.localeCompare(b.agentId),
  );
  return { sessions, visits, revision };
}

/** Retain structural selection facts; every assertion still checks live disclosure authority. */
export function prepareTaskPublicationSessions(
  projection: SessionRowProjection,
  root: PublicationRow,
  getAllows: () => (row: EntryRow) => boolean,
) {
  let prepared = selectTaskPublicationSessions(projection, root, getAllows());
  const sessions = prepared.sessions;
  return {
    sessions,
    assertCurrent: () => {
      // Registry publication can defer the lineage update until preparation.
      void projection.state;
      const allows = getAllows();
      if (prepared.revision === projection.readTaskPublicationRevision()) {
        const sharing = projection.sharingRevision;
        const rows = sharing ? getOrCreateWeakOwnerMap(rowsByRevision, sharing) : undefined;
        const unchanged = prepared.visits.every(({ node, duplicate, included }) => {
          const row = readPublicationRow(projection, node, rows);
          return duplicate || allowsPublicationRow(row, allows) === included;
        });
        // Capturing a deferred row can itself publish new lineage.
        if (unchanged && prepared.revision === projection.readTaskPublicationRevision()) {
          return;
        }
      }
      const current = selectTaskPublicationSessions(projection, root, allows);
      if (
        current.sessions.length !== sessions.length ||
        current.sessions.some((session, index) => {
          const previous = sessions[index];
          return (
            session !== previous &&
            (session.agentId !== previous?.agentId ||
              session.sessionKey !== previous.sessionKey ||
              session.sessionId !== previous.sessionId ||
              session.lifecycleRevision !== previous.lifecycleRevision)
          );
        })
      ) {
        throw new Error("Task pull-request audience changed");
      }
      prepared = current;
    },
  };
}

type ReceiptResult = {
  taskPullRequests: ControlUiSessionTaskPullRequest[];
  taskPullRequestCount: number;
  pullRequestCount: number;
};
const cache = createRetainedCache<Promise<ReceiptResult>>();
// Receipt commits and database retirement, rather than a poll TTL, own this derived cache.
githubPublicationReceipts.subscribeFacts((change) => {
  if (change.kind === "committed" || change.kind === "unknown") {
    cache.clear();
  }
});
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    cache.clear();
  }
});

export async function readTaskPullRequestReceipts(
  input: TaskPublicationRead,
  assertCurrent: () => void,
  signal?: AbortSignal,
): Promise<ReceiptResult> {
  assertCurrent();
  const source = captureOpenClawStateReadContext();
  source.admission.assertCurrent();
  const key = JSON.stringify([source.admission.identity.key, input]);
  let pending = cache.get(key, signal);
  if (!pending) {
    pending = (async () => {
      const { readGitHubPublicationInWorker } =
        await import("../state/github-publication-worker.js");
      const reply = await readGitHubPublicationInWorker({
        type: "githubPublications.taskReceipts",
        input,
      });
      source.admission.assertCurrent();
      const result =
        reply?.type === "githubPublications.taskReceipts"
          ? reply.result
          : { receipts: [], count: 0, branchMatchCount: 0 };
      const taskPullRequests: ControlUiSessionTaskPullRequest[] = [];
      for (const row of result.receipts) {
        const url = row.pull_request_url ? URL.parse(row.pull_request_url) : null;
        const parts = url?.pathname.split("/");
        const number = Number(parts?.[4]);
        if (
          !url ||
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          parts?.length !== 5 ||
          parts[3] !== "pull" ||
          !parts[1] ||
          !parts[2] ||
          !Number.isSafeInteger(number) ||
          number < 1
        ) {
          continue;
        }
        taskPullRequests.push({
          url: url.href,
          owner: parts[1],
          repo: parts[2],
          number,
          branch: row.branch,
          ...(row.title ? { title: row.title } : {}),
          sourceSessionKey: row.session_key,
          sourceAgentId: row.agent_id,
        });
      }
      return {
        taskPullRequests,
        taskPullRequestCount: result.count,
        pullRequestCount: result.count + (input.branchUrls?.length ?? 0) - result.branchMatchCount,
      };
    })();
    cache.set(key, pending, signal);
    const selected = pending;
    void pending.catch(() => cache.delete(key, selected));
  }
  const result = await pending;
  source.admission.assertCurrent();
  assertCurrent();
  return result;
}
