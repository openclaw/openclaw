import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, vi } from "vitest";
import { repositoryGitHubPublicationDigest } from "../gateway/github-repository-publication.kernel.js";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { publicationRowDefaults } from "./github-publication-fixtures.test-support.js";
import type { RepositoryGitHubPublicationRow } from "./github-publication-read.types.js";
import type { RepositoryPublicationMutation } from "./github-publication-worker.types.js";

export function publicationCommand(input: RepositoryPublicationMutation) {
  const operationId = `${input.operation}-${"row" in input ? input.row.request_id : "report"}`;
  return {
    type: "githubPublications.repository" as const,
    input: { ...input, operationId },
  };
}

export function repositoryRow(requestId: string): RepositoryGitHubPublicationRow {
  const row: RepositoryGitHubPublicationRow = {
    ...publicationRowDefaults(requestId),
    requester_authority_json: null,
    session_id: "publication-worker-session",
    session_lifecycle_revision: null,
    session_key: "agent:main:publication-worker",
    workspace_id: "publication-worker-workspace",
    owner_profile_id: null,
    connection_generation: null,
    identity_source: "system-configured",
    identity_profile_id: "fixture-profile",
    previous_head_commit: null,
    claim_id: null,
    run_id: null,
    environment_id: null,
    owner_epoch: null,
    placement_generation: null,
    checkpoint_ref: "refs/openclaw/worker-results/fixture",
    checkpoint_digest: `sha256:${"a".repeat(64)}`,
    pushed_head_commit: null,
  };
  row.request_digest = repositoryGitHubPublicationDigest(row);
  return row;
}

export async function expectNoMainThreadSql(operation: () => Promise<void>) {
  const sql = observeMainThreadSql();
  try {
    sql.calibrate();
    await operation();
    sql.expectIdle();
  } finally {
    sql.restore();
  }
}

export async function expectNoWorkerRequests(operation: () => Promise<void>) {
  using requests = vi.spyOn(Worker.prototype, "postMessage");
  await operation();
  expect(requests).not.toHaveBeenCalled();
}

const heldReplies = new Set<() => void>();

export function releaseHeldGitHubPublicationMessages() {
  for (const release of heldReplies) {
    release();
  }
}

export function holdNextReply(
  commandType = "githubPublications.repository",
  beforeDispatch?: () => void,
) {
  const ready = createDeferredCore();
  let deliver: ((error?: Error) => void) | undefined;
  let target: { worker: Worker; id: number } | undefined;
  // Restored spies retain native call-through; Reflect.apply supplies each live Worker.
  const postMessage = vi.spyOn(Worker.prototype, "postMessage");
  postMessage.mockRestore();
  const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    ...args
  ) {
    if (request.type === "execute") {
      const workerCommand: unknown = deserialize(request.input);
      if (
        workerCommand &&
        typeof workerCommand === "object" &&
        "type" in workerCommand &&
        workerCommand.type === commandType
      ) {
        target = { worker: this, id: request.id };
        posts.mockRestore();
        beforeDispatch?.();
      }
    }
    return Reflect.apply(postMessage, this, [request, ...args]);
  });
  const emit = vi.spyOn(Worker.prototype, "emit");
  emit.mockRestore();
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
    ...args
  ) {
    if (event === "message" && this === target?.worker && reply.id === target.id && reply.ok) {
      messages.mockRestore();
      deliver = (error) => {
        const outcome: SqliteWorkerReply = error
          ? {
              id: reply.id,
              ok: false,
              error: { name: error.name, message: error.message, code: "outcome-unknown" },
            }
          : reply;
        Reflect.apply(emit, this, [event, outcome, ...args]);
      };
      ready.resolve();
      return true;
    }
    return Reflect.apply(emit, this, [event, reply, ...args]);
  });
  const release = (error?: Error) => {
    const send = deliver;
    deliver = undefined;
    heldReplies.delete(release);
    try {
      send?.(error);
    } finally {
      postMessage.mockClear();
      emit.mockClear();
    }
  };
  heldReplies.add(release);
  return { ready: ready.promise, release };
}

export function holdNextReceipt() {
  const ready = createDeferredCore();
  let deliver: (() => void) | undefined;
  const observe = workerAdmission.observeSqliteWorkerCommittedFacts;
  vi.spyOn(workerAdmission, "observeSqliteWorkerCommittedFacts").mockImplementationOnce(
    (admission, observer) => {
      observe(admission, (receipt) => {
        deliver = () => observer(receipt);
        ready.resolve();
      });
    },
  );
  const release = () => {
    const send = deliver;
    deliver = undefined;
    heldReplies.delete(release);
    send?.();
  };
  heldReplies.add(release);
  return { ready: ready.promise, release };
}
