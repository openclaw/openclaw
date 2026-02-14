import type { MonitorIMessageOpts } from "./types.js";
import { createNonExitingRuntime, type RuntimeEnv } from "../../runtime.js";

export function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv {
  return opts.runtime ?? createNonExitingRuntime();
}

export function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}
