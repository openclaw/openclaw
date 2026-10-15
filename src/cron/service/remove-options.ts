import type { ClawPortableRemovalPrecondition } from "../../claws/portable-heartbeat-removal.types.js";
import type { CronCommitGuardOptions } from "./state.js";

export type CronRemoveOptions = CronCommitGuardOptions & {
  systemOwned?: boolean;
  clawPrecondition?: ClawPortableRemovalPrecondition;
};
