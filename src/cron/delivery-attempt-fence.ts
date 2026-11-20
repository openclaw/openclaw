import type { CronStandingGrantAuthority } from "./standing-grant-authority.types.js";

/** Host-held occurrence authority; never serialized into a tool or transport request. */
export type CronCompletionDeliveryFence = {
  /** The same receipt owner used by delivery, for standing exec grants. */
  standingGrantAuthority?: CronStandingGrantAuthority;
  beforeAttempt: () => Promise<void>;
  assertCurrent: () => void;
};
