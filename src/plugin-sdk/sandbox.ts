/**
 * Public SDK subpath for sandbox backends, SSH execution, and temp workspace helpers.
 */
export type {
  CreateSandboxBackendParams,
  RemoteShellSandboxHandle,
  RunSshSandboxCommandParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendFactory,
  SandboxFsBridge,
  SandboxFsStat,
  SandboxBackendHandle,
  SandboxBackendId,
  SandboxBackendManager,
<<<<<<< HEAD
  SandboxBackendPreparedWorkdirDiscarder,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirResolver,
  SandboxBackendWorkdirValidator,
=======
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirResolver,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  SandboxContext,
  SandboxResolvedPath,
  SandboxSshConfig,
  SshSandboxSession,
  SshSandboxSettings,
} from "../agents/sandbox.js";
export type { OpenClawConfig } from "../config/config.js";

export {
  buildExecRemoteCommand,
<<<<<<< HEAD
  buildRemoteWorkdirValidationCommand,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  buildRemoteCommand,
  buildSshSandboxArgv,
  buildValidatedExecRemoteCommand,
  createRemoteShellSandboxFsBridge,
  createWritableRenameTargetResolver,
  createSshSandboxSessionFromConfigText,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  getSandboxBackendFactory,
  getSandboxBackendManager,
  getSandboxBackendWorkdirResolver,
  isToolAllowed,
  registerSandboxBackend,
  requireSandboxBackendFactory,
  resolveSandboxRuntimeStatus,
  resolveWritableRenameTargets,
  resolveWritableRenameTargetsForBridge,
  runSshSandboxCommand,
  sanitizeEnvVars,
  shellEscape,
  uploadDirectoryToSshTarget,
} from "../agents/sandbox.js";

export {
  runPluginCommandWithTimeout,
  type PluginCommandRunOptions,
  type PluginCommandRunResult,
} from "./run-command.js";
export { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
export {
  tempWorkspace,
  tempWorkspaceSync,
  type TempWorkspace,
  type TempWorkspaceOptions,
  type TempWorkspaceSync,
  withTempWorkspace,
  withTempWorkspaceSync,
} from "../infra/private-temp-workspace.js";
