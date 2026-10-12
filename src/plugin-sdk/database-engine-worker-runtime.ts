/** Worker/admission-only physical store opening and transaction capabilities. */
export { openEngineStore } from "../infra/database-engine/open.js";
export { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
export {
  admitPostgresPhysicalFacts,
  physicalDatabaseCapabilities,
  requireNativeDatabaseFile,
} from "../infra/database-engine/physical-facts.js";
export type { PostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
export {
  runEngineStoreReadSnapshot,
  runEngineWorkerWrite,
} from "../infra/database-engine/adapters.js";
export type {
  EngineConnection,
  StoreSchema,
  DatabaseEngineAdapter,
} from "../infra/database-engine/contract.js";
export type { DatabaseEngineInput } from "../infra/database-engine/config.js";
