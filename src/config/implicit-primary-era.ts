import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { listAgentIds } from "../agents/agent-roster.js";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveAgentModelPrimaryValue } from "./model-input.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { compareOpenClawVersions } from "./version.js";

/** The last release that ran an implicit model when config named none. */
const LAST_IMPLICIT_PRIMARY_RELEASE = "2026.11.6";

/** True for a config last written by a release that ran an implicit model. */
export function isImplicitPrimaryEraConfig(cfg: OpenClawConfig | undefined): boolean {
  const touched = cfg?.meta?.lastTouchedVersion;
  return (
    touched === undefined ||
    (compareOpenClawVersions(touched, LAST_IMPLICIT_PRIMARY_RELEASE) ?? 1) <= 0
  );
}

/** True while some agent still relies on the retired implicit model. */
function hasAgentWithoutPrimary(cfg: OpenClawConfig): boolean {
  if (resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)) {
    return false;
  }
  return listAgentIds(cfg).some(
    (agentId) => !resolveAgentModelPrimaryValue(resolveAgentConfig(cfg, agentId)?.model),
  );
}

/**
 * Doctor decides, with credentials in hand, which model an implicit-era install keeps. Until a
 * primary is configured, config writes keep the era version so an unrelated save cannot end
 * that migration's eligibility.
 */
export function resolveConfigWriteTouchedVersion(
  cfg: OpenClawConfig,
  previousRaw: unknown,
  version: string,
): string {
  // The previous file is raw JSON; only its recorded version string matters here.
  if (!isRecord(previousRaw) || !hasAgentWithoutPrimary(cfg)) {
    return version;
  }
  const meta = isRecord(previousRaw.meta) ? previousRaw.meta : undefined;
  const previous =
    typeof meta?.lastTouchedVersion === "string" ? meta.lastTouchedVersion : undefined;
  // An existing file without a version predates version stamping, so it is implicit-era too;
  // stamp the era release so the next save still knows. A new file has no previous record.
  const newerRelease = (compareOpenClawVersions(version, LAST_IMPLICIT_PRIMARY_RELEASE) ?? 1) > 0;
  if (!newerRelease || !isImplicitPrimaryEraConfig({ meta: { lastTouchedVersion: previous } })) {
    return version;
  }
  return previous ?? LAST_IMPLICIT_PRIMARY_RELEASE;
}
