import "./sealed-runtime-bootstrap.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  coerceConfig,
  normalizeConfigIoDeps,
  parseConfigJson5,
  readConfigFileIfPresent,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
  resolveConfigPathForDeps,
} from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { DatabaseConfigSchema } from "../config/zod-schema.database.js";
import { routeLogsToStderr } from "../logging/console.js";
import { installDatabaseProcessRole } from "./database-engine/admission-scope.js";
import { resolveDatabaseEngineSelection } from "./database-engine/config.js";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { preparePostgresPoolForUpdate } from "./postgres-sync/pool.js";
import { registerSealedRuntimeProcessEntrypoints } from "./runtime-process-url.js";
import { readManagedHandoffUpdateRun } from "./update-managed-service-handoff-interrupted.js";
import {
  adoptUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";

routeLogsToStderr();
registerSealedRuntimeProcessEntrypoints("managedHandoff", import.meta.url);

export { parseLaunchctlJob } from "../daemon/launchctl-job.js";
export { classifyUpdateOutcome } from "../shared/update-outcome-classification.js";

export { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
export { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
export { resolveImmutableSqliteFileUri } from "./node-sqlite.js";
export { procCgroupMembershipMatches } from "./update-managed-service-handoff-scope.js";
export { packageActivationIdentity } from "./package-update-activation-paths.js";
export {
  recoverInterruptedManagedUpdate,
  readManagedHandoffGatewayStop,
} from "./update-managed-service-handoff-interrupted.js";
export { findUpdateGatewayStop } from "./update-run-gateway-stop.js";
/** The detached one-shot resolves its own canonical store before adopting the run. */
export async function prepareManagedHandoffLedger(isCurrent: () => boolean) {
  const assertCurrent = () => {
    if (!isCurrent()) {
      throw new Error("Managed handoff ledger lost its current claim");
    }
  };
  assertCurrent();
  // As with authored store discovery, reuse config resolution without pulling
  // plugin validation, migrations or writers into this installation-independent runtime.
  const env = cloneEnvWithPlatformSemantics(process.env);
  const deps = normalizeConfigIoDeps({ env, observe: false });
  const configPath = resolveConfigPathForDeps(deps);
  const parsed = parseConfigJson5(readConfigFileIfPresent(deps, configPath) ?? "{}");
  if (!parsed.ok) {
    throw new Error(`Cannot parse managed handoff configuration at ${configPath}.`);
  }
  const resolved = resolveConfigForRead(
    resolveConfigIncludesForRead(parsed.parsed, configPath, deps),
    env,
    deps.lowerPrecedenceEnv,
  );
  if (
    !isRecord(resolved.resolvedConfigRaw) ||
    !DatabaseConfigSchema.safeParse(resolved.resolvedConfigRaw.database).success
  ) {
    throw new Error(`Invalid managed handoff database configuration at ${configPath}.`);
  }
  const config = coerceConfig(resolved.resolvedConfigRaw);
  setConfigResolutionFacts(config, resolved.resolutionFacts);
  const selection = await resolveDatabaseEngineSelection(config, env);
  assertCurrent();
  installDatabaseProcessRole("cli-oneshot");
  installDatabaseEngineSelection(selection);
  await preparePostgresPoolForUpdate("openclaw update repair");
  assertCurrent();
  return {
    adoptUpdateRun,
    finishUpdateRun,
    getUpdateRun: readManagedHandoffUpdateRun,
    recordUpdateRunStep,
    recordUpdateRunVerification,
  };
}
export {
  finishUpdateRun,
  recordUpdateRunDiagnostic,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
export {
  inspectManagedHandoffSentinelRowSync,
  recordManagedHandoffSentinelOutcomeRowSync,
} from "./restart-sentinel-store.js";
export { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
export {
  createManagedHandoffLeaseStore,
  prepareManagedHandoffLeaseStore,
} from "./update-managed-service-handoff-lease.js";

export {
  resolveUpdateRestartNoticeMeta,
  shouldPublishUpdateRestartNotice,
} from "./update-restart-notice.js";
