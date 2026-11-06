import type { ProgressCard } from "../../packages/gateway-protocol/src/index.js";
import type { ProgressCardWrite } from "./progress-card-values.js";

/** An empty card retains its revision so a delayed dismissal cannot erase new work. */
export type SessionActorMemoryProgressCard = Omit<ProgressCard, "sessionKey">;
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
export type SessionActorProgressCardCommand = {
  [Key in keyof SessionActorProgressCardWrites]: {
    type: Key;
    input: SessionActorProgressCardWrites[Key]["input"];
  };
}[keyof SessionActorProgressCardWrites];
