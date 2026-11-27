import { listAgentIds, resolveEffectiveAgentDir } from "../agents/agent-scope-config.js";
import { resolveInstallAgentDir } from "../agents/install-agent-dir.js";
import { readCurrentConfigForResolution } from "../config/io.runtime.js";
import {
  resolveSessionStoreCompatibilityAgentId,
  tryGetLegacyDefaultAgentId,
} from "../config/legacy.default-agent-owner.js";
import {
  resolveLegacyAgentRosterOwner,
  type OpenClawConfigWithLegacyRoster,
} from "../config/legacy.roster.js";
import { isPerAgentSessionStoreConfig } from "../config/sessions/session-store-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LegacyStateDetection } from "./state-migrations.types.js";

const DEFERRED_LEGACY_OWNER_MESSAGE =
  "Deferred legacy agent/session migration: select an agent owner";

export function hasCustomAgentDirOverride(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim());
}

export function resolveLegacyStateMigrationOwner(params: {
  cfg: OpenClawConfig;
  locatorConfig: OpenClawConfigWithLegacyRoster;
  env: NodeJS.ProcessEnv;
  homedir: () => string;
}) {
  const { cfg, locatorConfig, env, homedir } = params;
  const installAgentDir = resolveInstallAgentDir(
    (resolutionEnv) =>
      readCurrentConfigForResolution({ config: locatorConfig, env: resolutionEnv }),
    { env, homedir },
  );
  const installedTarget = installAgentDir.migrationTarget;
  const preimageOwner =
    tryGetLegacyDefaultAgentId(cfg) ?? resolveLegacyAgentRosterOwner(locatorConfig);
  // Doctor's allocated source identity can differ from both the system agent and raw duplicate ids.
  const migrationTarget =
    preimageOwner && listAgentIds(cfg).includes(preimageOwner)
      ? {
          owner: preimageOwner,
          dir: hasCustomAgentDirOverride(env)
            ? installedTarget?.dir
            : resolveEffectiveAgentDir(cfg, preimageOwner, { env, homedir }),
        }
      : installedTarget;
  const migrationAgentId = migrationTarget?.owner;
  const sessionMigrationAgentId =
    migrationAgentId ??
    (!isPerAgentSessionStoreConfig(locatorConfig.session?.store)
      ? resolveSessionStoreCompatibilityAgentId(locatorConfig)
      : undefined);
  return { installAgentDir, migrationTarget, migrationAgentId, sessionMigrationAgentId };
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
