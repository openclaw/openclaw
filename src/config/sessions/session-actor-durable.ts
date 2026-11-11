import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import {
  prepareSessionEntryReplacementDatabase,
  withSessionEntryWorker,
} from "./session-accessor.sqlite-replacement-worker.js";
import type {
  SessionActor,
  SessionActorLifetime,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { createSessionActorReplica } from "./session-actor-replica.js";
import { createSessionActor } from "./session-actor.js";

/** Capture once; every command borrows the existing physical writer admission. */
export function captureDurableSessionActor(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  target: SessionActorTarget & {
    database: Extract<SessionActorTarget["database"], { kind: "file" }>;
  };
  lifetime: SessionActorLifetime;
}): SessionActor {
  const database = {
    ...params.database,
    env: Object.freeze({ ...(params.database.env ?? process.env) }),
  };
  const execution = captureOpenClawAgentDatabaseExecution(database, {
    expectedIdentity: params.target.database,
  });
  return bindDurableSessionActor({ ...params, database }, execution);
}

function bindDurableSessionActor(
  params: Parameters<typeof captureDurableSessionActor>[0],
  execution: OpenClawAgentDatabaseExecution,
): SessionActor {
  const database = params.database;
  const lifetime = {
    assertAdmission: () => params.lifetime.assertAdmission?.(),
    assertCurrent: () => {
      params.lifetime.assertCurrent();
      execution.assertCurrent();
    },
    assertReadable: () => {
      params.lifetime.assertReadable();
      execution.assertCurrent();
    },
  };
  return createSessionActor({
    target: params.target,
    lifetime,
    replica: createSessionActorReplica({
      target: params.target,
      lifetime,
      currentGeneration() {
        return execution.capturePreparedGenerationClaim()?.incarnation;
      },
    }),
    transport: {
      agentId: database.agentId,
      run: (operation, authorize, concurrentBoardReads) => {
        const prepared = concurrentBoardReads
          ? execution.capturePreparedGenerationClaim()
          : undefined;
        const assertCurrent = () => {
          lifetime.assertCurrent();
          prepared?.assertCurrent();
        };
        return withSessionEntryWorker(
          database,
          execution.fileIdentity?.physicalIdentity,
          assertCurrent,
          async (_execution, source) => {
            // Cold preparation retains exclusive admission; a qualified append cannot reopen.
            if (prepared) {
              prepared.assertCurrent();
            } else {
              await execution.prepare(source);
            }
            return operation({
              async execute(command) {
                const result = await execution.runExisting(source, (worker) =>
                  worker.execute(command),
                );
                if (result === undefined) {
                  throw new Error("Session actor database disappeared");
                }
                return result;
              },
            });
          },
          undefined,
          execution,
          undefined,
          undefined,
          undefined,
          (admission, retained, request, grant) => {
            authorize(request, { admission, retained }, grant);
            return true;
          },
          undefined,
          "write",
          undefined,
          prepared ? concurrentBoardReads : undefined,
        );
      },
      release: () => execution.release(),
    },
  });
}

type AcquisitionTarget = {
  database: SessionActorTarget["database"] | { kind: "memory" | "file" };
  sessionKey: string;
};

/** One actor contract selects either its durable worker or memory owner at acquisition. */
export function createSessionActorFactory(
  database: OpenClawAgentDatabaseOptions & { path: string },
) {
  const captured = {
    ...database,
    env: Object.freeze({ ...(database.env ?? process.env) }),
  };
  return {
    async acquire(
      requestedTarget: AcquisitionTarget,
      lifetime: SessionActorLifetime,
      followRegistration?: AgentDatabaseRequestExecutionSource["onRegistryChange"],
    ) {
      lifetime.assertAdmission?.();
      lifetime.assertCurrent();
      if (requestedTarget.database.kind === "memory") {
        const owner = memorySessionActorOwners.get(captured);
        return owner.acquire(
          {
            sessionKey: requestedTarget.sessionKey,
            database:
              "handle" in requestedTarget.database ? requestedTarget.database : owner.identity,
          },
          lifetime,
        );
      }
      const sessionKey = requestedTarget.sessionKey;
      const execution = captureOpenClawAgentDatabaseExecution(captured, {
        expectedIdentity:
          "physicalIdentity" in requestedTarget.database ? requestedTarget.database : undefined,
      });
      try {
        if (!execution.fileIdentity) {
          await prepareSessionEntryReplacementDatabase(
            captured,
            () => lifetime.assertCurrent(),
            execution,
            followRegistration,
          );
        }
        lifetime.assertCurrent();
        const identity = execution.fileIdentity;
        if (!identity) {
          throw new Error("Durable session actor has no admitted physical database");
        }
        return bindDurableSessionActor(
          {
            database: captured,
            target: { sessionKey, database: { ...identity } },
            lifetime,
          },
          execution,
        );
      } catch (error) {
        await execution.release();
        throw error;
      }
    },
  };
}
