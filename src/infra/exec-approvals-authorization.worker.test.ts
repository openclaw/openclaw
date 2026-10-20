import path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { publishAgentDeletionJournalStatus } from "../state/agent-deletion-journal-status.js";
import * as stateDatabase from "../state/openclaw-state-db.js";
import type { WorkerWriteOperationContext } from "../state/worker-operation-registry.js";
import { commitExecAuthorizationsInWorker } from "./exec-approvals-authorization.worker.js";
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import { writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    stateDatabase.closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
// Transport admission is covered by the real worker store suite; these cases own the reducer transaction.
beforeEach(() => {
  vi.spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission").mockImplementation(() => {});
});
const entry = { id: "echo", pattern: "/usr/bin/echo" };
const input: ExecAuthorizationCommitInput = {
  agentId: "main",
  matches: [],
  command: "echo first",
  authorization: {
    source: "current-policy",
    security: "allowlist",
    ask: "on-miss",
    allowlistSatisfied: true,
  },
};
const usage = { ...input, matches: [entry] };
const changed = { ok: false, message: "Exec approval changed before execution" };
function fixture() {
  const root = tempDirs.make("openclaw-exec-authorization-batch-");
  const options = {
    path: path.join(root, "state", "openclaw.sqlite"),
    env: { OPENCLAW_STATE_DIR: root },
  };
  const database = stateDatabase.openOpenClawStateDatabase(options);
  writeExecApprovalsConfigRow({
    db: database.db,
    file: { version: 1, agents: { main: { allowlist: [entry] } } },
  });
  const context: WorkerWriteOperationContext = {
    open: () => database,
    writeAdmitted: () => {
      throw new Error("Exec authorizations retain their custom admission");
    },
    stateOptions: () => options,
    write: (operation, transactionOptions) => {
      const { port1, port2 } = new MessageChannel();
      try {
        return workerAdmission.withSqliteWorkerOperationAdmission({ port: port1 }, () =>
          stateDatabase.runOpenClawStateWriteTransaction(
            operation,
            { ...options, database },
            transactionOptions,
          ),
        );
      } finally {
        port1.close();
        port2.close();
      }
    },
  };
  return {
    database,
    commit: (...items: ExecAuthorizationCommitInput[]) =>
      commitExecAuthorizationsInWorker({ items }, context),
  };
}

it("does not acquire writer admission for an unchanged authorization batch", () => {
  const { commit } = fixture();
  const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
  const outcomes = commit(input, input);
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
  expect(writes).not.toHaveBeenCalled();
});

it("coalesces usage writes and rereads policy after writer admission", () => {
  const { commit, database } = fixture();
  const write = stateDatabase.runOpenClawStateWriteTransaction;
  const writes = vi
    .spyOn(stateDatabase, "runOpenClawStateWriteTransaction")
    .mockImplementationOnce((operation, owner, transactionOptions) => {
      writeExecApprovalsConfigRow({
        db: database.db,
        file: { version: 1, defaults: { security: "deny" } },
      });
      return write(operation, owner, transactionOptions);
    });
  const outcomes = commit(usage, { ...usage, command: "echo last" });
  expect(writes).toHaveBeenCalledTimes(1);
  expect(outcomes).toEqual([changed, changed]);
});

it("commits accepted usage once and preserves the agent deletion fence", () => {
  const { commit, database } = fixture();
  writeExecApprovalsConfigRow({
    db: database.db,
    file: { version: 1, agents: { main: { allowlist: [entry] }, deleted: { allowlist: [entry] } } },
  });
  database.db
    .prepare(
      "INSERT INTO agent_deletion_journal(agent_id,operation_id,agent_dir,workspace_dir,sessions_dir,created_at) VALUES('deleted','deletion','/agent','/workspace','/sessions',1)",
    )
    .run();
  publishAgentDeletionJournalStatus(database.db, "deleted", "pending");
  const writes = vi.spyOn(stateDatabase, "runOpenClawStateWriteTransaction");
  const outcomes = commit(
    usage,
    { ...usage, agentId: "deleted" },
    { ...usage, command: "echo last" },
  );
  expect(writes).toHaveBeenCalledTimes(1);
  expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true]);
  expect(
    outcomes.map((outcome) => (outcome.ok ? outcome.snapshot.file.agents : null)),
  ).toMatchObject([
    { main: { allowlist: [{ lastUsedCommand: "echo first" }] } },
    null,
    {
      main: { allowlist: [{ lastUsedCommand: "echo last" }] },
      deleted: { allowlist: [entry] },
    },
  ]);
});

it.each(["explicit-approval", "auto-review"] as const)(
  "rejects %s usage without its delayed policy snapshot",
  (source) => {
    const { commit } = fixture();
    expect(commit({ ...usage, authorization: { ...input.authorization, source } })).toEqual([
      changed,
    ]);
    const [unchanged] = commit(input);
    expect(unchanged?.ok && unchanged.snapshot.file.agents?.main?.allowlist).toEqual([entry]);
  },
);
