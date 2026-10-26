import { channel } from "node:diagnostics_channel";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { stageSessionPendingInput as stageInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { appendTranscriptMessage as appendMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readPendingInputSourceInDatabase as readSource } from "../../config/sessions/session-pending-input-source.kernel.js";
import { DebugProxyCaptureKernel } from "../../proxy-capture/store.kernel.js";
import {
  readSkillUsageInDatabase as readUsage,
  recordSkillUsageInDatabase as recordUsage,
} from "../../skills/workshop/skill-usage.kernel.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase as openAgent,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { ensureSessionPendingInputsSchema } from "../../state/openclaw-agent-pending-inputs-schema.js";
import {
  openOpenClawStateDatabase as openState,
  runOpenClawStateWriteTransaction as writeState,
} from "../../state/openclaw-state-db.js";
import * as receipts from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} database portability`,
    () => {
      useMixedAgentPair(engine, engine);

      it("retains first and latest usage when skill events arrive out of order", () =>
        admit(() => {
          const database = openState();
          const skillFile = "/synthetic/skills/portability/SKILL.md";
          writeState(
            (writer) => {
              for (const [ts, agentId] of [
                [200, "initial"],
                [100, "earliest"],
                [300, "latest"],
                [150, "late-arrival"],
                [300, undefined],
              ] as const) {
                recordUsage(writer, {
                  skillFile,
                  skillKey: "portability",
                  skillName: "Portability",
                  skillSource: "synthetic",
                  agentId,
                  ts,
                });
              }
            },
            { database },
          );
          expect(readUsage(database, [skillFile])).toEqual([
            { skillFile, useCount: 5, lastUsedAtMs: 300 },
          ]);
          expect(
            database.db
              .prepare(
                "SELECT first_used_at_ms, last_used_at_ms, use_count, last_agent_id FROM skill_usage WHERE skill_file = ?",
              )
              .get(skillFile),
          ).toEqual({
            first_used_at_ms: 100,
            last_used_at_ms: 300,
            use_count: 5,
            last_agent_id: null,
          });
        }));

      it("retains the earliest capture start when repeated session writes update metadata", () =>
        admit(() => {
          const database = openState();
          const capture = new DebugProxyCaptureKernel({
            db: database.db,
            dbPath: database.path,
            blobDir: database.path,
            runWrite: (operation) => writeState(operation, { database }),
          });
          const id = "scalar-capture-session";
          for (const session of [
            { startedAt: 200, mode: "implicit", sourceProcess: "synthetic-initial" },
            {
              startedAt: 100,
              mode: "proxy",
              endedAt: 250,
              sourceProcess: "synthetic-earlier",
              proxyUrl: "http://synthetic.invalid",
            },
            { startedAt: 300, mode: "replacement", sourceProcess: "synthetic-latest" },
          ]) {
            capture.upsertSession({ id, sourceScope: "openclaw", ...session });
          }
          expect(capture.listSessions()).toEqual([
            {
              id,
              startedAt: 100,
              endedAt: null,
              mode: "proxy",
              sourceProcess: "synthetic-latest",
              proxyUrl: null,
              eventCount: 0,
            },
          ]);
        }));

      it.skipIf(!mixedAgentConnection)(
        "keeps a peer borrower after caller refusal follows a committed opening lease",
        async () => {
          const options = { agentId: "receipt-refusal", env: process.env };
          const state = admit(() => openState());
          const leaseCount = () =>
            admit(() =>
              Number(
                state.db
                  .prepare("SELECT COUNT(*) AS count FROM agent_database_leases WHERE agent_id = ?")
                  .get(options.agentId)?.count,
              ),
            );
          const source = admit(() => openAgent(options));
          admit(() => closeOpenClawAgentDatabaseByPath(source.path));
          await closeOpenClawAgentDatabaseByPathAsync(source.path);
          const initiator = captureOpenClawAgentDatabaseExecution(options);
          const retained = captureOpenClawAgentDatabaseExecution(options);
          const refusal = new Error("Opening caller refused validation after its lease committed");
          let refused = false;
          let committedLeaseCount = 0;
          const createAdmission = receipts.createSqliteWorkerOperationAdmission;
          const refuseValidation = vi
            .spyOn(receipts, "createSqliteWorkerOperationAdmission")
            .mockImplementation((authorize, attachment) =>
              createAdmission((request, grant) => {
                if (
                  !refused &&
                  isRecord(attachment) &&
                  attachment.kind === "agent-execution" &&
                  request.stage === "prepare" &&
                  isRecord(request.facts) &&
                  request.facts.kind === "agent-validation-start"
                ) {
                  committedLeaseCount = leaseCount();
                  refused = true;
                  throw refusal;
                }
                authorize(request, grant);
              }, attachment),
            );
          const owner: AgentDatabaseRequestExecutionSource = {
            assertCurrent() {},
            createAdmission: (binding) => () => ({
              nativeLocations: binding.nativeLocations,
              admission: receipts.createSqliteWorkerOperationAdmission((request, grant) => {
                binding.authorize(request);
                if (!grant()) {
                  throw new Error("Receipt lifecycle caller admission expired");
                }
              }, binding.attachment),
            }),
          };
          const operation = vi.fn(async () => "not admitted");
          try {
            await expect(initiator.runExisting(owner, operation)).rejects.toBe(refusal);
            expect(refused).toBe(true);
            expect(committedLeaseCount).toBe(1);
            expect(operation).not.toHaveBeenCalled();
            expect(leaseCount()).toBe(0);
            expect(() => retained.assertCurrent()).not.toThrow();
            await expect(
              retained.runExisting(owner, (scope) =>
                scope.execute({
                  type: "session.transcript.initialize",
                  input: {
                    sessionKey: "agent:receipt-refusal:retained",
                    sessionId: "retained-after-refusal",
                  },
                }),
              ),
            ).resolves.toMatchObject({
              kind: "session-transcript-initialized",
              sessionKey: "agent:receipt-refusal:retained",
            });
          } finally {
            refuseValidation.mockRestore();
            await Promise.all([initiator.release(), retained.release()]);
          }
        },
      );

      it.each(["new", "pending", "committed"] as const)(
        "reads a %s source with bounded SQL and observes session replacement",
        async (source) => {
          const database = admit(() => openAgent({ agentId: "main" }));
          const input = {
            kind: "source" as const,
            sessionKey: `agent:main:source-count-${source}`,
            sessionId: `source-session-${source}`,
            idempotencyKey: "new-input:user",
            pendingOnly: false,
          };
          admit(() => {
            ensureSessionPendingInputsSchema(database.db);
            writeSessionEntry(database, input.sessionKey, {
              sessionId: input.sessionId,
              updatedAt: 1,
            });
          });
          const scope = {
            agentId: "main",
            sessionKey: input.sessionKey,
            sessionId: input.sessionId,
          };
          const receipt =
            source === "new"
              ? undefined
              : await stageInput(scope, {
                  runId: "new-input",
                  message: {
                    role: "user",
                    content: "Synthetic retained input",
                    timestamp: 1,
                    idempotencyKey: input.idempotencyKey,
                  },
                  assertCurrent() {},
                });
          if (source === "committed") {
            expect(receipt).toBeDefined();
            await receipt!.run(() => appendMessage(scope, { message: receipt!.message }));
          }
          const read = () => {
            let statements = 0;
            const observation = channel("openclaw.database.statement");
            const observer = () => {
              statements++;
            };
            observation.subscribe(observer);
            try {
              const result = admit(() => readSource(database, input));
              const expected =
                source === "new" || input.pendingOnly ? 1 : source === "pending" ? 6 : 9;
              expect(statements).toBe(expected);
              return result;
            } finally {
              observation.unsubscribe(observer);
            }
          };
          try {
            const result = read();
            expect(result.current).toBe(true);
            if (source === "pending") {
              expect(result.pending?.message_json).toBe(JSON.stringify(receipt!.message));
            } else if (source === "committed") {
              expect(result.committed).toEqual(receipt!.message);
              input.pendingOnly = true;
              expect(read()).toEqual({ kind: "source", current: true });
            } else {
              expect(result).toEqual({ kind: "source", current: true });
              admit(() =>
                writeSessionEntry(database, input.sessionKey, {
                  sessionId: "replacement-session",
                  updatedAt: 2,
                }),
              );
              expect(read()).toEqual({ kind: "source", current: false });
            }
          } finally {
            receipt?.finish("interrupted");
            await receipt?.settled?.();
          }
        },
      );
    },
  );
}
