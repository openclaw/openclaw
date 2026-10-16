// Retrieval workers use SQLite, read-only ownership checks, and text/vector
// primitives without loading memory managers, migrations, or agent configuration.
export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
export { extractKeywords } from "../../packages/memory-host-sdk/src/host/query-expansion.js";
export { loadSqliteVecExtension } from "../infra/database-engine/sqlite-vec.js";
export { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
export { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
export {
  openNodeSqliteDatabase,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";

export { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
export { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
export {
  decodeMemoryEmbedding,
  parseEmbedding,
} from "../../packages/memory-host-sdk/src/host/embedding-vector.js";

export type { VectorCapability, VectorIndex } from "../infra/database-engine/vector-contract.js";
export { admitStoreSearch } from "../infra/database-engine/adapters.js";
export type { SearchStore } from "../infra/database-engine/search.js";
export { matchesVectorRow } from "../infra/database-engine/vector-contract.js";
