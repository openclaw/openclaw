import { MessagePort } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { receiveAuthProfileUpdateValue } from "../agents/auth-profiles/store-update-transfer.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { readExactSessionEntryRow as readSessionRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { withOpenClawTestState as withState } from "../test-utils/openclaw-test-state.js";
import {
  createAgentDatabaseInspectionRefusal as inspectionRefusal,
  preparePendingAgentDatabase as preparePending,
  readAgentDatabaseAdmissionRefusal as readRefusal,
  recordAgentDatabaseAdmissions as recordAdmissions,
} from "./agent-database-admission.js";
import { publishAgentDeletionJournalStatus } from "./agent-deletion-journal-status.js";
import { openOpenClawAgentDatabase as openAgentDb } from "./openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution as captureExecution } from "./openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath as stateSqlitePath } from "./openclaw-state-db.paths.js";

it.each([
  "normal-startup-normal",
  "deletion-before-commit",
  "auth-read",
  "deletion-before-auth-publication",
] as const)(
  "reuses the native actor with request-scoped startup journal checks (%s)",
  async (scenario) => {
    await withState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "worker", env: state.env };
      const sessionKey = "agent:worker:startup-journal";
      replaceSessionEntrySync(
        { ...options, sessionKey },
        { sessionId: "startup-journal", updatedAt: 1, label: "seed" },
      );
      const authStore = {
        version: 1,
        profiles: {
          "fixture:startup": {
            type: "token" as const,
            provider: "fixture",
            token: "synthetic-startup-credential",
          },
        },
      };
      const authScenario =
        scenario === "auth-read" || scenario === "deletion-before-auth-publication";
      if (authScenario) {
        saveAuthProfileStore(authStore, state.agentDir("worker"), {
          filterExternalAuthProfiles: false,
          syncExternalCli: false,
        });
      }
      const database = openAgentDb(options);
      const execution = captureExecution(options);
      const writer = openNodeSqliteDatabase(stateSqlitePath(state.env));
      const insertDeletion = () => {
        writer
          .prepare(
            `INSERT INTO agent_deletion_journal
             (agent_id, operation_id, agent_dir, workspace_dir, sessions_dir,
              database_paths_json, cleanup_paths_json, created_at, cleanup_completed, delete_files)
             VALUES ('worker', 'raw-startup-deletion', ?, ?, ?, ?, '[]', 1, 0, 0)`,
          )
          .run(
            state.agentDir("worker"),
            state.workspaceDir,
            state.sessionsDir("worker"),
            JSON.stringify([database.path]),
          );
        publishAgentDeletionJournalStatus(writer, "worker", "pending");
      };
      const incarnations = new Set<string>();
      let authRows: unknown;
      let afterAuthorize: ((request: SqliteWorkerAdmissionRequest) => void) | undefined;
      const source: AgentDatabaseRequestExecutionSource = {
        assertCurrent: () => execution.assertCurrent(),
        createAdmission: (binding) => () => ({
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
            if (isRecord(request.facts) && isRecord(request.facts.publication)) {
              const publication = request.facts.publication;
              if (publication.kind === "auth-store-read") {
                if (!(publication.port instanceof MessagePort)) {
                  throw new Error("Auth read omitted its field transport");
                }
                try {
                  authRows = receiveAuthProfileUpdateValue(publication.port);
                } finally {
                  publication.port.close();
                }
              }
            }
            afterAuthorize?.(request);
            if (!grant()) {
              throw new Error("Startup journal fixture lost native admission");
            }
          }, binding.attachment),
        }),
      };
      const replace = async (label: string) => {
        const previous = expectDefined(readSessionRow(database, sessionKey), "Missing seeded row");
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
      const readLabel = () => readSessionRow(database, sessionKey)?.entry.label;
      const replaceNormally = async (label: string) => {
        await replace(label);
        expect(readLabel()).toBe(label);
      };
      try {
        await execution.runExisting(source, (scope) =>
          scope.execute({ type: "database.prepareWrite", input: undefined }),
        );
        await replaceNormally("normal-before");
        const refusal = inspectionRefusal({
          agentId: "worker",
          paths: [database.path],
          pending: true,
          reason: "native startup preparation",
        });
        recordAdmissions([refusal], { env: state.env, source: "startup" });
        const replaceDuringStartup = (label: string) =>
          preparePending(refusal, { env: state.env, assertCurrent() {} }, async () => {
            await replace(label);
          });
        let inserted = false;
        const deletionStage =
          scenario === "deletion-before-auth-publication"
            ? "prepare"
            : scenario === "deletion-before-commit"
              ? "transaction"
              : undefined;
        afterAuthorize = (request) => {
          if (deletionStage === request.stage && !inserted) {
            inserted = true;
            // A separate connection bypasses canonical begin's admission invalidation.
            insertDeletion();
          }
        };
        if (authScenario) {
          const read = preparePending(refusal, { env: state.env, assertCurrent() {} }, async () => {
            await execution.runExisting(source, (scope) =>
              scope.execute({ type: "authProfiles.read", input: undefined }),
            );
          });
          if (scenario === "deletion-before-auth-publication") {
            await expect(read).rejects.toThrow("deleted during startup inspection");
            expect(inserted).toBe(true);
            expect(authRows).toBeUndefined();
            expect(readRefusal("worker", options)).toBe(refusal);
          } else {
            await read;
            expect(authRows).toMatchObject({ store: { status: "readable", raw: authStore } });
            expect(readRefusal("worker", options)).toBeUndefined();
          }
        } else if (scenario === "deletion-before-commit") {
          await expect(replaceDuringStartup("must-roll-back")).rejects.toThrow(
            "deleted during startup inspection",
          );
          expect(inserted).toBe(true);
          expect(readRefusal("worker", options)).toBe(refusal);
          expect(readLabel()).toBe("normal-before");
        } else {
          await replaceDuringStartup("startup");
          expect(readRefusal("worker", options)).toBeUndefined();
          expect(readLabel()).toBe("startup");
        }
        afterAuthorize = undefined;
        if (scenario === "normal-startup-normal") {
          insertDeletion();
          await replaceNormally("normal-after");
        }
        expect(incarnations.size).toBe(1);
      } finally {
        afterAuthorize = undefined;
        writer
          .prepare("DELETE FROM agent_deletion_journal WHERE operation_id = ?")
          .run("raw-startup-deletion");
        publishAgentDeletionJournalStatus(writer, "worker", "absent");
        writer.close();
        recordAdmissions([], { env: state.env, source: "startup" });
        await execution.release();
      }
    });
  },
);
