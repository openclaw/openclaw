import "./sealed-runtime-bootstrap.js";
import { routeLogsToStderr } from "../logging/console.js";
import { readManagedHandoffUpdateRun } from "./update-managed-service-handoff-interrupted.js";
import {
  adoptUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";

routeLogsToStderr();

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
export const handoffLedger = {
  adoptUpdateRun,
  finishUpdateRun,
  getUpdateRun: readManagedHandoffUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
};
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
