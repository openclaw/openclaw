import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  collectConfiguredAgentHarnessRuntimes,
  type ConfiguredAgentHarnessRuntimeOptions,
} from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export function acpxRuntimeIsConfigured(cfg: OpenClawConfig): boolean {
  const acp = asOptionalRecord(cfg.acp);
  const backend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
  return backend
    ? backend === "acpx"
    : acp?.enabled === true || asOptionalRecord(acp?.dispatch)?.enabled === true;
}

/** Collect runtime ids without loading plugin metadata during startup planning. */
export function collectConfiguredRuntimeIds(
  cfg: OpenClawConfig,
  options?: ConfiguredAgentHarnessRuntimeOptions,
): string[] {
  const ids = new Set(collectConfiguredAgentHarnessRuntimes(cfg, options));
  if (acpxRuntimeIsConfigured(cfg)) {
    ids.add("acpx");
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}
