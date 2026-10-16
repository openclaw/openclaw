/** Worker/admission-only physical store opening and transaction capabilities. */
export { openEngineStore } from "../infra/database-engine/open.js";
export { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
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
export { jsonPathValue } from "../infra/database-engine/json-values.js";
export { admitStoreSearch } from "../infra/database-engine/adapters.js";
export type {
  SearchSchema,
  SearchStore,
  StoreSearchCapabilities,
} from "../infra/database-engine/search.js";
export type {
  FullTextCapability,
  TextIndex,
  TextIndexDefinition,
  TextQuery,
} from "../infra/database-engine/text-contract.js";
export type {
  VectorCapability,
  VectorIndex,
  VectorSearch,
} from "../infra/database-engine/vector-contract.js";
