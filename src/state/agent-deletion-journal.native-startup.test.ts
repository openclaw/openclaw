import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { readExactSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { openOpenClawAgentDatabase } from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const journalReads = vi.hoisted(() => new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
vi.mock("../infra/worker-cpu.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/worker-cpu.js")>();
  const preload = `
    import { DatabaseSync } from "node:sqlite";
    import { workerData } from "node:worker_threads";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (/\\bFROM\\s+"?agent_deletion_journal"?\\b/i.test(sql)) {
        for (const method of ["all", "get", "iterate", "run"]) {
          const execute = statement[method].bind(statement);
          statement[method] = (...args) => {
            Atomics.add(new Int32Array(workerData.testStartupJournalReads), 0, 1);
            return execute(...args);
          };
        }
      }
      return statement;
    };
  `;
  return {
    ...actual,
    createCpuTrackedWorker(
      filename: string | URL,
      options: ConstructorParameters<typeof Worker>[1],
    ) {
      return actual.createCpuTrackedWorker(filename, {
        ...options,
        execArgv: [
          ...(options?.execArgv ?? []),
          "--import",
          `data:text/javascript,${encodeURIComponent(preload)}`,
        ],
        workerData: { ...options?.workerData, testStartupJournalReads: journalReads },
      });
    },
  };
});

it.each(["normal-startup-normal", "deletion-before-commit"] as const)(
  "reuses the native actor with request-scoped startup journal checks (%s)",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "worker", env: state.env };
      const sessionKey = "agent:worker:startup-journal";
      replaceSessionEntrySync(
        { ...options, sessionKey },
        { sessionId: "startup-journal", updatedAt: 1, label: "seed" },
      );
      const database = openOpenClawAgentDatabase(options);
      const execution = captureOpenClawAgentDatabaseExecution(options);
      const writer = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(state.env));
      const insertDeletion = () =>
        writer
          .prepare(
            `INSERT INTO agent_deletion_journal
             (agent_id, operation_id, agent_dir, workspace_dir, sessions_dir,
              database_paths_json, cleanup_paths_json, created_at, cleanup_completed, delete_files)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "worker",
            "raw-startup-deletion",
            state.agentDir("worker"),
            state.workspaceDir,
            state.sessionsDir("worker"),
            JSON.stringify([database.path]),
            "[]",
            1,
            0,
            0,
          );
      const incarnations = new Set<string>();
      const startupStages = new Set<string>();
      let afterAuthorize: ((request: SqliteWorkerAdmissionRequest) => void) | undefined;
      const source: AgentDatabaseRequestExecutionSource = {
        assertCurrent: () => execution.assertCurrent(),
        createAdmission(binding) {
          return () => ({
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              binding.authorize(request);
              execution.assertCurrent();
              if (isRecord(request.facts) && isRecord(request.facts.identity)) {
                const identity = request.facts.identity;
                if (typeof identity.incarnation === "string") {
                  incarnations.add(identity.incarnation);
                }
              }
              if (binding.attachment.startupJournal) {
                startupStages.add(request.stage);
              }
              afterAuthorize?.(request);
              if (!grant()) {
                throw new Error("Startup journal fixture lost native admission");
              }
            }, binding.attachment),
          });
        },
      };
      const replace = async (label: string) => {
        const previous = readExactSessionEntryRow(database, sessionKey);
        if (!previous) {
          throw new Error("Missing seeded session row");
        }
        return execution.runExisting(source, (scope) =>
          scope.execute({
            type: "session.entries.replace",
            input: {
              expectedRows: new Map([[sessionKey, previous]]),
              validationKeys: [sessionKey],
              labelOwnerKeys: [],
              replacements: [{ sessionKey, entry: { ...previous.entry, label } }],
            },
          }),
        );
      };
      const reads = new Int32Array(journalReads);
      try {
        await execution.runExisting(source, (scope) =>
          scope.execute({ type: "database.prepareWrite", input: undefined }),
        );
        Atomics.store(reads, 0, 0);
        await replace("normal-before");
        expect(Atomics.load(reads, 0)).toBe(0);
        expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("normal-before");
        const refusal = createAgentDatabaseInspectionRefusal({
          agentId: "worker",
          paths: [database.path],
          pending: true,
          reason: "native startup preparation",
        });
        recordAgentDatabaseAdmissions([refusal], { env: state.env, source: "startup" });
        if (scenario === "deletion-before-commit") {
          let inserted = false;
          afterAuthorize = (request) => {
            if (request.stage === "transaction" && !inserted) {
              inserted = true;
              // A separate connection bypasses canonical begin's admission invalidation.
              insertDeletion();
            }
          };
          await expect(
            preparePendingAgentDatabase(
              refusal,
              { env: state.env, assertCurrent() {} },
              async () => {
                await replace("must-roll-back");
              },
            ),
          ).rejects.toThrow("deleted during startup inspection");
          expect(inserted).toBe(true);
          expect(readAgentDatabaseAdmissionRefusal("worker", options)).toBe(refusal);
          expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("normal-before");
        } else {
          await preparePendingAgentDatabase(
            refusal,
            { env: state.env, assertCurrent() {} },
            async () => {
              await replace("startup");
            },
          );
          expect(readAgentDatabaseAdmissionRefusal("worker", options)).toBeUndefined();
          expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("startup");
          expect(startupStages).toEqual(new Set(["prepare", "transaction", "commit"]));
        }
        expect(Atomics.load(reads, 0)).toBeGreaterThan(0);
        afterAuthorize = undefined;
        if (scenario === "normal-startup-normal") {
          insertDeletion();
          Atomics.store(reads, 0, 0);
          await replace("normal-after");
          expect(Atomics.load(reads, 0)).toBe(0);
          expect(readExactSessionEntryRow(database, sessionKey)?.entry.label).toBe("normal-after");
        }
        expect(incarnations.size).toBe(1);
      } finally {
        afterAuthorize = undefined;
        writer
          .prepare("DELETE FROM agent_deletion_journal WHERE operation_id = ?")
          .run("raw-startup-deletion");
        writer.close();
        recordAgentDatabaseAdmissions([], { env: state.env, source: "startup" });
        await execution.release();
      }
    });
  },
);
