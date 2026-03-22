/**
 * ACPX Runtime Plugin SDK exports
 *
 * This module provides ACP runtime backend functionality for OpenClaw plugins.
 */

// Core plugin types
export type {
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../plugins/types.js";

// ACP runtime types
export type {
  AcpRuntime,
  AcpRuntimeHandle,
  AcpRuntimePromptMode,
  AcpRuntimeSessionMode,
  AcpSessionUpdateTag,
  AcpRuntimeControl,
  AcpRuntimeEnsureInput,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpRuntimeCapabilities,
  AcpRuntimeStatus,
  AcpRuntimeDoctorReport,
  AcpRuntimeEvent,
} from "../acp/runtime/types.js";

// ACP runtime errors
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";

export {
  ACP_ERROR_CODES,
  AcpRuntimeError,
  isAcpRuntimeError,
  toAcpRuntimeError,
  withAcpRuntimeErrorBoundary,
} from "../acp/runtime/errors.js";

// ACP runtime registry
export {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  getAcpRuntimeBackend,
  requireAcpRuntimeBackend,
} from "../acp/runtime/registry.js";

export type { AcpRuntimeBackend } from "../acp/runtime/registry.js";

// Windows spawn types and functions
export type {
  WindowsSpawnProgram,
  WindowsSpawnProgramCandidate,
  WindowsSpawnResolution,
  ResolveWindowsSpawnProgramParams,
  ResolveWindowsSpawnProgramCandidateParams,
} from "./windows-spawn.js";

export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "./windows-spawn.js";

// Auth env var helpers
export { listKnownProviderEnvApiKeyNames } from "../agents/model-auth-env-vars.js";

// Env helpers
export { omitEnvKeysCaseInsensitive } from "../secrets/provider-env-vars.js";
