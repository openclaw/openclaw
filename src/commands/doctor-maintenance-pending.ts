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

/** Every decision Doctor took before its stop, by step, in the order it took them. */
export type DoctorPendingDecisions = Map<string, DoctorMaintenancePending>;

// Set while a stop runs whose decisions were all taken before it (see `handDoctorPendingDecisionsToStop`).
let decidedBeforeStop: ReadonlyMap<string, DoctorMaintenancePending> | undefined;

async function decide(check?: DoctorMaintenancePendingCheck): Promise<DoctorMaintenancePending> {
  if (!check) {
    return "work";
  }
  try {
    return await check();
  } catch {
    return "undecidable";
  }
}

/**
 * Records one step's decision in the Doctor startup trace (`doctor.pending.<step>`,
 * with `pending=` and `check=default|owner`). A step without a check has work.
 * Returns whether the step has work; callers do not act on it yet.
 *
 * With `into`, the decision is taken before the stop and kept there (traced with
 * `at=before-stop`). Inside a stop that was handed those decisions, a step already
 * decided returns its recorded answer without running its check again or tracing it twice.
 */
export async function traceDoctorMaintenancePending(
  step: string,
  check?: DoctorMaintenancePendingCheck,
  into?: DoctorPendingDecisions,
): Promise<boolean> {
  const recorded = into ? undefined : decidedBeforeStop?.get(step);
  if (recorded) {
    return recorded !== "none";
  }
  let pending: DoctorMaintenancePending = "work";
  pending = await measureGatewayBootstrapStep(
    `doctor.pending.${step}`,
    async () => (pending = await decide(check)),
    () => ({
      pending,
      check: check ? "owner" : "default",
      ...(into ? { at: "before-stop" } : {}),
    }),
  );
  into?.set(step, pending);
  return pending !== "none";
}

/**
 * Hands the decisions taken before the stop to the stop until disposed: its steps run as
 * before, and their pending traces return these answers instead of deciding again.
 */
export function handDoctorPendingDecisionsToStop(
  decisions: ReadonlyMap<string, DoctorMaintenancePending>,
): Disposable {
  const previous = decidedBeforeStop;
  decidedBeforeStop = decisions;
  return {
    [Symbol.dispose]: () => {
      decidedBeforeStop = previous;
    },
  };
}
