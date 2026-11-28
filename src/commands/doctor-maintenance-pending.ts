import { measureGatewayBootstrapStep } from "../cli/startup-trace.js";

/**
 * Whether a Doctor maintenance step has work. "undecidable" means the step's owner
 * could not tell (unreadable store, unknown shape, failed probe) and counts as work.
 */
export type DoctorMaintenancePending = "work" | "none" | "undecidable";

/**
 * A step owner's read-only "is there work?" answer. It must not write, open a store
 * in a mode that can create or modify files, or copy a database. A thrown error is
 * recorded as "undecidable".
 */
export type DoctorMaintenancePendingCheck = () =>
  | DoctorMaintenancePending
  | Promise<DoctorMaintenancePending>;

/**
 * Records one step's decision in the Doctor startup trace (`doctor.pending.<step>`,
 * with `pending=` and `check=default|owner`). A step without a check has work.
 * Returns whether the step has work; callers do not act on it yet.
 */
export async function traceDoctorMaintenancePending(
  step: string,
  check?: DoctorMaintenancePendingCheck,
): Promise<boolean> {
  let pending: DoctorMaintenancePending = "work";
  const decide = async (): Promise<DoctorMaintenancePending> => {
    if (!check) {
      return "work";
    }
    try {
      return await check();
    } catch {
      return "undecidable";
    }
  };
  pending = await measureGatewayBootstrapStep(
    `doctor.pending.${step}`,
    async () => (pending = await decide()),
    () => ({ pending, check: check ? "owner" : "default" }),
  );
  return pending !== "none";
}
