import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as receipts from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s agent opening refusal",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("keeps a peer borrower after caller refusal follows a committed opening lease", async () => {
      const options = { agentId: "receipt-refusal", env: process.env };
      const state = admit(() => openOpenClawStateDatabase());
      const source = admit(() => openOpenClawAgentDatabase(options));
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
              committedLeaseCount = admit(() =>
                Number(
                  state.db
                    .prepare(
                      "SELECT COUNT(*) AS count FROM agent_database_leases WHERE agent_id = ?",
                    )
                    .get(options.agentId)?.count,
                ),
              );
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
        expect(
          admit(() =>
            Number(
              state.db
                .prepare("SELECT COUNT(*) AS count FROM agent_database_leases WHERE agent_id = ?")
                .get(options.agentId)?.count,
            ),
          ),
        ).toBe(0);
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
    });
  },
);
