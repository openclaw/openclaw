import type { DoctorMaintenancePendingCheck } from "./doctor-maintenance-pending.js";

/**
 * The owners whose work `doctor.config-flow` runs inside the stop. The step has work unless
 * every input has a read-only check and it answers none; an input without a check has work.
 * Adding a predicate for a remaining owner is one `check` here.
 */
export function doctorConfigFlowPendingInputs(params: {
  env: NodeJS.ProcessEnv;
  integrityCheck: "quick" | "full";
}): ReadonlyArray<{ id: string; check?: DoctorMaintenancePendingCheck }> {
  return [
    {
      id: "state-schema",
      check: async () => {
        const { planOpenClawStateDatabaseDoctorRepair } =
          await import("../state/openclaw-state-db-doctor-repair-plan.js");
        return (await planOpenClawStateDatabaseDoctorRepair(params)).decision;
      },
    },
    // Agent database migration (maintenance leases, seals, ensure transactions, registry).
    { id: "agent-databases" },
    // The plugin obligation ledger's settlement and deferred plugin migrations.
    { id: "plugin-obligations" },
  ];
}

/**
 * Traces each input as `config-flow.<id>`, then the step itself from their answers.
 * `trace` is Doctor's maintenance tracer; it returns whether that check has work.
 */
export async function traceConfigFlowPendingInputs(
  trace: (step: string, check?: DoctorMaintenancePendingCheck) => Promise<boolean> | undefined,
  params: Parameters<typeof doctorConfigFlowPendingInputs>[0],
): Promise<void> {
  let work = false;
  for (const input of doctorConfigFlowPendingInputs(params)) {
    // A missing check is work without a trace of its own; the step's line records it.
    work = (input.check ? await trace(`config-flow.${input.id}`, input.check) : true) || work;
  }
  await trace("config-flow", () => (work ? "work" : "none"));
}
