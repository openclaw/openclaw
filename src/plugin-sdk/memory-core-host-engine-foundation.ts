/**
 * Public SDK foundation surface for memory host engine config, paths, and shared helpers.
 */
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";

export * from "../../packages/memory-host-sdk/src/engine-foundation.js";
export {
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
export {
  resolveMemorySearchConfig,
  resolveMemorySearchSyncConfig,
  type ResolvedMemorySearchConfig,
  type ResolvedMemorySearchSyncConfig,
} from "../agents/memory-search.js";
export { parseDurationMs } from "../cli/parse-duration.js";
export { loadConfig } from "../config/config.js";
export type { OpenClawConfig } from "../config/config.js";
export { resolveStateDir } from "../config/paths.js";
export { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
export {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  type SecretInput,
} from "../config/types.secrets.js";
export type { SessionSendPolicyConfig } from "../config/types.base.js";
export type {
  MemoryBackend,
  MemoryCitationsMode,
  MemoryQmdConfig,
  MemoryQmdIndexPath,
  MemoryQmdMcporterConfig,
  MemoryQmdSearchMode,
} from "../config/types.memory.js";
export type { MemorySearchConfig } from "../config/types.tools.js";
export { root } from "../infra/fs-safe.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { detectMime } from "@openclaw/media-core/mime";
export { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
export { resolveGlobalSingleton } from "../shared/global-singleton.js";
export { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
export { splitShellArgs } from "../utils/shell-argv.js";

const MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY = Symbol.for(
  "openclaw.memoryCore.sessionTranscriptUpdateSubscriber",
);

// Memory-core needs target-only internal updates before the SQLite flip, while
// the public SDK listener stays file-backed during the compatibility window.
(globalThis as Record<symbol, unknown>)[MEMORY_CORE_TRANSCRIPT_UPDATE_SUBSCRIBER_KEY] ??=
  onInternalSessionTranscriptUpdate;

export {
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  truncateUtf16Safe,
} from "../utils.js";
