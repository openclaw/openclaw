import { expect, it, vi } from "vitest";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { createSessionEntryWithTranscript } from "./session-accessor.js";
import { readSessionSharingAuthorityHealth } from "./session-sharing-authority-state.js";
import { initializeSessionTranscriptInWorker } from "./session-transcript-initialization.js";

it.each(["replacement", "transcript"] as const)(
  "keeps rejected %s receipts denied instead of reconciling them as missing",
  async (producer) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await captureRuntimeConfigAsyncReader()();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const scope = {
        agentId: "main",
        storePath: database.path,
        sessionKey: `agent:main:conflict-${producer}`,
      };
      const sessionId = `conflict-${producer}`;
      let rejected = 0;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const admissionSpy = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((...args) => {
          const admission = createAdmission(...args);
          const descriptor = Object.getOwnPropertyDescriptor(admission, "committed");
          if (!descriptor?.get) {
            throw new Error("Missing native receipt getter");
          }
          const read = descriptor.get.bind(admission);
          Object.defineProperty(admission, "committed", {
            configurable: true,
            get() {
              const committed: unknown = read();
              if (!committed) {
                return committed;
              }
              rejected++;
              return { facts: { kind: "unexpected-native-receipt" } };
            },
          });
          return admission;
        });
      const capture = executionOwner.captureOpenClawAgentDatabaseExecutionAsync;
      const open = vi
        .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecutionAsync")
        .mockImplementation(async (...args) => {
          const execution = await capture(...args);
          const runExisting: typeof execution.runExisting = (source, operation, options) => {
            return execution.runExisting(
              source,
              (worker) =>
                operation({
                  ...worker,
                  async execute(command) {
                    const value = await worker.execute(command);
                    if (
                      command.type === "session.transcript.initialize" ||
                      command.type === "session.entries.replace"
                    ) {
                      throw new SqliteWorkerError("ordinary reply lost", "outcome-unknown");
                    }
                    return value;
                  },
                }),
              options,
            );
          };
          return new Proxy(execution, {
            get(target, property, receiver) {
              return property === "runExisting"
                ? runExisting
                : Reflect.get(target, property, receiver);
            },
          });
        });
      try {
        const failure = await (
          producer === "replacement"
            ? createSessionEntryWithTranscript(scope, () => ({
                ok: true,
                entry: { sessionId, updatedAt: 1 },
              }))
            : initializeSessionTranscriptInWorker(
                { agentId: "main", path: database.path },
                readOpenClawAgentDatabaseIdentity(database).identity,
                { sessionKey: scope.sessionKey, sessionId },
                () => {},
              )
        ).catch((error: unknown) => error);
        expect(hasSqliteWorkerOutcomeUnknown(failure), String(failure)).toBe(true);
        expect(rejected).toBeGreaterThan(0);
        open.mockRestore();
        admissionSpy.mockRestore();
        expect(readSessionSharingAuthorityHealth(true)?.reasons).toEqual(["conflicting-receipt"]);
        await expect(
          prepareSessionMutationFacts({ cfg: { agents: { entries: { main: {} } } }, ...scope }),
        ).rejects.toThrow(/restart the Gateway/i);
      } finally {
        open.mockRestore();
        admissionSpy.mockRestore();
      }
    });
  },
);
