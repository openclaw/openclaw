import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
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
      run: (operation, authorize) =>
        withSessionEntryWorker(
          database,
          execution.fileIdentity?.physicalIdentity,
          lifetime.assertCurrent,
          async (_execution, source) => {
            await execution.prepare(source);
            return operation({
              captureGeneration: () => execution.captureGenerationClaim(),
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
        ),
      release: () => execution.release(),
    },
  });
}

type AcquisitionTarget = SessionActorTarget | { database: { kind: "memory" }; sessionKey: string };

/** One actor contract selects either its durable worker or memory owner at acquisition. */
export function createSessionActorFactory(
  database: OpenClawAgentDatabaseOptions & { path: string },
) {
  const captured = {
    ...database,
    env: Object.freeze({ ...(database.env ?? process.env) }),
  };
  return {
    async acquire(requestedTarget: AcquisitionTarget, lifetime: SessionActorLifetime) {
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
      const target = {
        sessionKey: requestedTarget.sessionKey,
        database: structuredClone(requestedTarget.database),
      };
      return captureDurableSessionActor({
        database: captured,
        target: { sessionKey: target.sessionKey, database: target.database },
        lifetime,
      });
    },
  };
}

/** Existing durable callers share the same acquisition owner. */
export const createDurableSessionActorFactory = createSessionActorFactory;
