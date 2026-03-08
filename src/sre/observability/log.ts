import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("sre/obs");

export function logSreMetric(name: string, fields: Record<string, unknown> = {}): void {
  log.info(
    JSON.stringify({
      kind: "sre_metric",
      name,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
}
