import { createRetainedCache } from "../infra/retained-cache.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getOrCreateWeakOwnerMap } from "../shared/weak-owner-map.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type { TaskPublicationRead } from "../state/github-publication-task-reads.worker.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import type { ControlUiSessionTaskPullRequest } from "./control-ui-contract.js";
import type { EntryRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

type PublicationNode = {
  row: EntryRow;
  identity: string;
  session: TaskPublicationRead["sessions"][number];
  children?: PublicationNode[];
};
// Row revisions own structural facts, never a viewer's permission to consume them.
const nodesByRevision = new WeakMap<object, Map<EntryRow, PublicationNode>>();

/** Traverse the row owner's indexed lineage; neither checkout nor transcript is evidence. */
export function selectTaskPublicationSessions(
  projection: SessionRowProjection,
  root: EntryRow,
  allows: (row: EntryRow) => boolean,
): TaskPublicationRead["sessions"] {
  // Registry publications can defer parent-index updates until row preparation.
  void projection.state;
  const revision = projection.sharingRevision;
  const nodes = revision
    ? getOrCreateWeakOwnerMap(nodesByRevision, revision)
    : new Map<EntryRow, PublicationNode>();
  const prepare = (row: EntryRow): PublicationNode => {
    const retained = nodes.get(row);
    if (retained) {
      return retained;
    }
    const node: PublicationNode = {
      row,
      identity: JSON.stringify([row.agentId, row.key, row.entry.sessionId]),
      session: {
        agentId: row.agentId,
        sessionKey: row.key,
        sessionId: row.entry.sessionId,
        lifecycleRevision: row.entry.lifecycleRevision ?? null,
      },
    };
    nodes.set(row, node);
    return node;
  };
  const seen = new Set<string>();
  const pending = [prepare(root)];
  const sessions: TaskPublicationRead["sessions"] = [];
  for (const node of pending) {
    const { row, identity } = node;
    if (
      seen.has(identity) ||
      row.entry.incognito ||
      isIncognitoSessionKey(row.key) ||
      !allows(row)
    ) {
      continue;
    }
    seen.add(identity);
    sessions.push(node.session);
    node.children ??= projection.selectEntries({ parentSessionKey: row }).map(prepare);
    pending.push(...node.children);
  }
  return sessions.toSorted(
    (a, b) => a.sessionKey.localeCompare(b.sessionKey) || a.agentId.localeCompare(b.agentId),
  );
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
