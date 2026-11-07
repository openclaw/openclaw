import { readGatewayCrashCause } from "../daemon/gateway-crash-cause.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { enrichGatewayCrashAsync } from "./gateway-boot-lifecycle.js";
import { formatGatewayCrash, type GatewayCrashRecord } from "./gateway-crash.js";

/** Called once for the predecessor returned by the committed boot transition. */
export async function reportPreviousGatewayCrash(
  previous: GatewayCrashRecord,
  log: Pick<SubsystemLogger, "warn">,
  env = process.env,
): Promise<void> {
  let crash = previous;
  try {
    const evidence = await readGatewayCrashCause(previous, env);
    if (evidence) {
      crash = (await enrichGatewayCrashAsync(previous.bootId, evidence, env)) ?? previous;
    }
  } catch {
    // Inspection and enrichment cannot erase the durable unclean-exit fact.
  }
  log.warn(`previous Gateway run ended unexpectedly: ${formatGatewayCrash(crash)}`);
}
