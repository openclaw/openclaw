import { createNonExitingRuntime, type RuntimeEnv } from "../../runtime.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import type { MonitorIMessageOpts } from "./types.js";

export function resolveRuntime(opts: MonitorIMessageOpts): RuntimeEnv {
  return opts.runtime ?? createNonExitingRuntime();
}

export function normalizeAllowList(list?: Array<string | number>) {
  return normalizeStringEntries(list);
}
