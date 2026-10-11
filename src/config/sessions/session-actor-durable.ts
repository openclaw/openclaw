import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import type {
  SessionActor,
  SessionActorLifetime,
  SessionActorTarget,
} from "./session-actor-contract.js";
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
        const generation = execution.capturePreparedGenerationClaim();
        generation?.assertCurrent();
        return generation?.incarnation;
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

type AcquisitionTarget =
  | SessionActorTarget
  | { database: { kind: "native-incognito" }; sessionKey: string };

/** Native incognito keeps its existing owner and gets no actor savings until P12. */
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
      if (requestedTarget.database.kind === "native-incognito") {
        return { kind: "not-actor-owned" } as const;
      }
      const target: SessionActorTarget = {
        sessionKey: requestedTarget.sessionKey,
        database: structuredClone(requestedTarget.database),
      };
      if (target.database.kind === "file") {
        return captureDurableSessionActor({
          database: captured,
          target: { sessionKey: target.sessionKey, database: target.database },
          lifetime,
        });
      }
      const expected = target.database;
      const existing = captureOpenClawAgentDatabaseExecution
        .listIncognito(captured.env)
        .find(
          (owner) =>
            owner.agentId === captured.agentId &&
            owner.storePath === captured.path &&
            owner.identity.handle === expected.handle &&
            owner.identity.incarnation === expected.incarnation,
        );
      if (!existing) {
        throw new Error("Incognito session actor lost its captured worker owner");
      }
      const execution = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: captured.agentId,
        env: captured.env,
        existingOnly: true,
        authority: {
          assertCurrent() {
            lifetime.assertCurrent();
            existing.assertCurrent();
          },
        },
      });
      if (!execution) {
        throw new Error("Incognito session actor owner is unavailable");
      }
      try {
        const actor = await execution.sessionActors.acquire(target, lifetime);
        return {
          ...actor,
          async release() {
            await actor.release();
            await execution.release();
          },
        };
      } catch (error) {
        await execution.release();
        throw error;
      }
    },
  };
}

/** Existing cutover callers retain the factory name. */
export const createDurableSessionActorFactory = createSessionActorFactory;
