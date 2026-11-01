import { vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { githubPublicationReceipts } from "./github-publication-receipts.js";
import * as stateReads from "./openclaw-state-db-readonly.js";

export function waitForPublicationGate(
  signal: AbortSignal,
  operation: PromiseLike<unknown>,
  ...gates: PromiseLike<unknown>[]
) {
  return withinTest(
    awaitGateBeforeSettlement(
      Promise.all(gates),
      operation,
      "publication settled before observation",
    ),
    signal,
  );
}

export function holdStateRead(type?: string) {
  const ready = createDeferredCore();
  const release = createDeferredCore();
  const read = stateReads.executeExistingOpenClawStateRead;
  const delayed: typeof read = async (options, command, readOptions) => {
    const result = await read(options, command, readOptions);
    if (!type || command.type === type) {
      ready.resolve();
      await release.promise;
    }
    return result;
  };
  const spy = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  if (type) {
    spy.mockImplementation(delayed);
  } else {
    spy.mockImplementationOnce(delayed);
  }
  return { ready: ready.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

export function observePublicationAuthority() {
  const facts = new Map<string, unknown>();
  const unknown: Array<string | symbol> = [];
  const stop = githubPublicationReceipts.subscribeFacts((change) => {
    if (change.kind === "committed") {
      for (const [key, fact] of change.receipt.facts) {
        facts.set(key, fact);
      }
    } else if (change.kind === "unknown") {
      unknown.push(change.identity);
    }
  });
  return { facts, unknown, stop };
}

export function publicationRowDefaults(requestId: string) {
  return {
    request_id: requestId,
    idempotency_key: requestId,
    request_digest: "",
    session_id: requestId,
    session_key: `agent:main:${requestId}`,
    agent_id: "main",
    identity_account_id: 42,
    identity_login: "fixture-bot",
    title: null,
    body: null,
    draft: null,
    status: "requested",
    gateway_instance_id: null,
    execution_id: null,
    push_repository: "example/repository",
    repository: "example/repository",
    branch: "openclaw/worker-proof",
    base_branch: "main",
    source_head_commit: "b".repeat(40),
    source_index_tree: "c".repeat(40),
    workspace_tree: "c".repeat(40),
    head_commit: null,
    pull_request_url: null,
    error_code: null,
    next_action: null,
    last_effect: null,
    effect_state: null,
    created_at_ms: 1000,
    updated_at_ms: 1000,
    reported_at_ms: null,
  };
}
