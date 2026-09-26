import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LegacyStateDetection } from "./state-migrations.types.js";

const DEFERRED_LEGACY_OWNER_MESSAGE =
  "Deferred legacy agent/session migration: select an agent owner";

export function tryResolveDoctorSessionMigrationAgentId(
  cfg: OpenClawConfig,
  migrationAgentId: string | undefined,
): string | undefined {
  return (
    migrationAgentId ??
    (!isPerAgentSessionStoreConfig(cfg.session?.store)
      ? resolveSessionStoreCompatibilityAgentId(cfg)
      : undefined)
  );
}

/** A migration destination is not proof that runtime consumes the source. */
export function classifyLegacyOwnerFindings(params: {
  requiredWarnings: readonly string[];
  agentInspections: readonly {
    source: { standalone: boolean };
    inspection: { status: "empty" | "payload" } | { status: "failed"; warning: string };
    outsideSnapshot: boolean;
  }[];
  usesLegacyRuntimeDirectory: () => boolean;
  deferredSessions: boolean;
  deferredAgentDir: boolean;
  doctorOnlyStateMigrations?: boolean;
}): Pick<LegacyStateDetection, "warnings" | "notices" | "warningDisposition" | "outcome"> {
  const requiredWarnings = [...params.requiredWarnings];
  const advisoryWarnings: string[] = [];
  for (const { source, inspection, outsideSnapshot } of params.agentInspections) {
    if (inspection.status !== "failed") {
      continue;
    }
    // The SDK still reads its selected standalone store until migration completes.
    const required = source.standalone && !outsideSnapshot && params.usesLegacyRuntimeDirectory();
    (required ? requiredWarnings : advisoryWarnings).push(inspection.warning);
  }
  const warnings = [
    ...requiredWarnings,
    ...advisoryWarnings,
    ...(params.deferredSessions ||
    (params.deferredAgentDir && params.doctorOnlyStateMigrations === true)
      ? [DEFERRED_LEGACY_OWNER_MESSAGE]
      : []),
  ];
  const notices =
    params.deferredAgentDir && params.doctorOnlyStateMigrations !== true
      ? [DEFERRED_LEGACY_OWNER_MESSAGE]
      : [];
  return {
    warnings,
    notices,
    ...(requiredWarnings.length === 0 && (warnings.length > 0 || notices.length > 0)
      ? { warningDisposition: "recoverable", outcome: "deferred" }
      : {}),
  };
}
