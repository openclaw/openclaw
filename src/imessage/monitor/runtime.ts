import { createNonExitingRuntime, type RuntimeEnv } from "../../runtime.js";
import type { MonitorIMessageOpts } from "./types.js";

export function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv {
  return opts.runtime ?? createNonExitingRuntime();
}

export function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}
