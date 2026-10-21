import assert from "node:assert/strict";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import type {
  AgentDatabaseExecutionScope,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";

type ExecutionModule = typeof import("../../state/openclaw-agent-execution.js");
type Decorate = (worker: AgentDatabaseExecutionScope) => AgentDatabaseExecutionScope;

export async function withHostDataSql<T>(
  run: (sql: ReturnType<typeof observeHostDataSql>) => Promise<T>,
  observe?: Parameters<typeof observeHostDataSql>[0],
): Promise<T> {
  const sql = observeHostDataSql(observe);
  using _ = { [Symbol.dispose]: sql.restore };
  return await run(sql);
}

export function publication(request: admission.SqliteWorkerAdmissionRequest) {
  const facts = isRecord(request.facts) ? request.facts.publication : undefined;
  return isRecord(facts) ? facts : undefined;
}

export function observeNativeGrants(
  module: typeof admission,
  observe: (
    request: admission.SqliteWorkerAdmissionRequest,
    facts: Record<string, unknown>,
  ) => void,
) {
  return probe.admission(module, (request, grant, admit) => {
    const facts = publication(request);
    if (facts) {
      observe(request, facts);
    }
    admit(request, grant);
  });
}

export function observeNativeCommit(module: typeof admission, observe = () => {}) {
  const committed = vi.fn(observe);
  observeNativeGrants(module, (request, facts) => {
    if (request.stage === "commit" && facts.kind === "session-native-binding") {
      committed();
    }
  });
  return committed;
}

export function captureCommandWorker(type: string) {
  let terminate: (() => Promise<number>) | undefined;
  // Preserve the original receiver and target only the worker carrying this command.
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded below with the original worker receiver.
  const posted = Worker.prototype.postMessage;
  vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    const message: unknown = args[0];
    if (isRecord(message) && message.type === "execute" && message.input instanceof Uint8Array) {
      const command: unknown = deserialize(message.input);
      if (isRecord(command) && command.type === type) {
        terminate = () => this.terminate();
      }
    }
    return posted.apply(this, args);
  });
  return () => {
    assert(terminate, "the requested command must dispatch before its commit grant");
    return terminate();
  };
}

export const bindingWrites = (queries: readonly string[]) =>
  queries.filter((sql) =>
    /\b(?:delete\s+from|insert(?:\s+or\s+\w+)?\s+into)\s+["`]?plugin_state_entries\b/i.test(sql),
  );

export function expectNoSql(queries: readonly string[], pattern: RegExp) {
  expect(queries.filter((query) => pattern.test(query))).toEqual([]);
}

// Capture the originals before spying; keep both paths and their lazy identity getters intact.
export function spyAgentExecutions(module: ExecutionModule, decorate: Decorate) {
  const wrap =
    <Args extends unknown[]>(capture: (...args: Args) => OpenClawAgentDatabaseExecution) =>
    (...args: Args): OpenClawAgentDatabaseExecution => {
      const owner = capture(...args);
      return {
        ...owner,
        get fileIdentity() {
          return owner.fileIdentity;
        },
        runExisting: (source, operation, options) =>
          owner.runExisting(source, (worker) => operation(decorate(worker)), options),
      };
    };
  const capture = wrap(module.captureOpenClawAgentDatabaseExecution);
  const prepare = wrap(module.captureOpenClawAgentDatabasePreparationExecution);
  vi.spyOn(module, "captureOpenClawAgentDatabaseExecution").mockImplementation(capture);
  vi.spyOn(module, "captureOpenClawAgentDatabasePreparationExecution").mockImplementation(prepare);
}
