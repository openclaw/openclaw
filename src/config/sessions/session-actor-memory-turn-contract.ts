import type { SessionTurnPlan } from "./session-turn.types.js";

export type SessionActorMemoryTurnReads = {
  "session.turn.prepare": {
    input: SessionTurnPlan;
    output: ReturnType<typeof import("./session-turn.worker.js").prepareSessionTurn>;
  };
};
