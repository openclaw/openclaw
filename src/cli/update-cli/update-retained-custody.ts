import type { ManagedHandoffRetainedCustody } from "../../infra/update-managed-service-handoff-lease-types.js";
import { formatCliCommand } from "../command-format.js";

/** Repair finished its own work, but cancelled custody still blocks the next update. */
export type RetainedUpdateCustodyReport = {
  nextAction: string;
  retainedUpdateCustody: ManagedHandoffRetainedCustody;
};

export function reportRetainedUpdateCustody(
  custody: ManagedHandoffRetainedCustody,
  env: NodeJS.ProcessEnv = process.env,
): RetainedUpdateCustodyReport {
  return {
    nextAction: `Cancelled update custody still blocks the next update. Resolve its reported reason, then rerun ${formatCliCommand("openclaw update repair", env)}.`,
    retainedUpdateCustody: custody,
  };
}
