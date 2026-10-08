import "./sealed-runtime-bootstrap.js";

export { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
export { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
export { resolveImmutableSqliteFileUri } from "./node-sqlite.js";
export {
  readRestartSentinelRowSync,
  writeRestartSentinelRowIfRevisionSync,
} from "./restart-sentinel-store.js";
export { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
export { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

export {
  resolveUpdateRestartNoticeMeta,
  shouldPublishUpdateRestartNotice,
} from "./update-restart-notice.js";
