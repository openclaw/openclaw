import type {
  SessionActor,
  SessionActorLifetime,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { createSessionActorWithExecutor } from "./session-actor-executor.js";
import type { createSessionActorReplica } from "./session-actor-replica.js";
import {
  createSqliteSessionActorExecutor,
  type SessionActorTransport,
} from "./session-actor-sqlite.js";

export type { SessionActorTransport } from "./session-actor-sqlite.js";

/** The actor batches phases over the selected execution owner's durable transport. */
export function createSessionActor(params: {
  target: SessionActorTarget;
  lifetime: SessionActorLifetime;
  transport: SessionActorTransport;
  replica: ReturnType<typeof createSessionActorReplica>;
}): SessionActor {
  return createSessionActorWithExecutor({
    target: params.target,
    lifetime: params.lifetime,
    createExecutor: (guards) => createSqliteSessionActorExecutor({ ...params, ...guards }),
  });
}
