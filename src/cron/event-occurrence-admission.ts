import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ScheduledOccurrence } from "./scheduled-occurrence.js";
import type { CronStoredJob } from "./types.js";

/**
 * Admits a hook or channel event's occurrence. An event occurrence has no
 * parent, so it holds nothing to release. Loads admission only when the turn runs.
 */
export async function admitEventOccurrence(params: {
  cfg: OpenClawConfig;
  job: CronStoredJob;
  agentId: string;
  ingressBoundary?: string;
}): Promise<ScheduledOccurrence> {
  const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
  return await admitScheduledOccurrence({ ...params, trigger: "event" });
}
