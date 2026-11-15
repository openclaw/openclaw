import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("worker/delivery");

export function reportSlowWorkerDelivery(
  fields: Record<string, number | string | undefined>,
): void {
  log.warn("slow SQLite worker delivery", fields);
}
