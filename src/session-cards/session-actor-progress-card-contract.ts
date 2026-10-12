import type { ProgressCard } from "../../packages/gateway-protocol/src/index.js";
import type { ProgressCardWrite } from "./progress-card-values.js";

export type SessionActorProgressCardReads = {
  "progressCard.get": {
    input: { sessionKey: string };
    output: ProgressCard | null;
  };
};
export type SessionActorProgressCardWrites = {
  "progressCard.put": {
    input: ProgressCardWrite & { sessionKey: string };
    output: { card: ProgressCard | null } | { cleared: true };
  };
  "progressCard.clearForReset": {
    input: { sessionKey: string };
    output: boolean;
  };
};
