import "./sealed-runtime-bootstrap.js";
import { routeLogsToStderr } from "../logging/console.js";

routeLogsToStderr();

export { parseLaunchctlJob } from "../daemon/launchctl-job.js";

export { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
export { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
export { resolveImmutableSqliteFileUri } from "./node-sqlite.js";
export { procCgroupMembershipMatches } from "./update-managed-service-handoff-scope.js";
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
