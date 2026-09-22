// Retrieval workers use SQLite, read-only ownership checks, and text/vector
// primitives without loading memory managers, migrations, or agent configuration.
export { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
export { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
export { ensureSqliteLibrarySelected } from "../infra/bun-sqlite-library.js";
export { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
export {
  openNodeSqliteDatabase,
  supportsNodeSqliteExtensionLoading,
} from "../infra/node-sqlite.js";

export { openOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-open.js";
export {
  cosineSimilarity,
  decodeMemoryEmbedding,
  parseEmbedding,
} from "../../packages/memory-host-sdk/src/host/embedding-vector.js";
