/**
 * Public SDK subpath for sandbox backends, SSH execution, and temp workspace helpers.
 */
export type {
  CreateSandboxBackendParams,
  CreateReservedSandboxBackendParamsV1,
  ReservedSandboxBackendFactoryV1,
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
  SandboxBackendPreparedWorkdirDiscarder,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirResolver,
  SandboxBackendWorkdirValidator,
  SandboxContext,
  SandboxResolvedPath,
  SandboxSshConfig,
  SshSandboxSession,
  SshSandboxSettings,
} from "../agents/sandbox.js";
export type { OpenClawConfig } from "../config/config.js";
export type { DirectoryEntry } from "../infra/directory-entries.js";
export { resolveReadOnlyWorkspaceSkillMounts } from "../agents/sandbox/workspace-mounts.js";

export {
  buildExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
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
  prepareSshSandboxExec,
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
export { SandboxRuntimeRetiredError } from "../agents/sandbox/provisioning-error.js";
export {
  createRemoteShellSandboxBackend,
  type RemoteShellSandboxBackendOptions,
} from "../agents/sandbox/remote-shell-backend.js";
export {
  createRemoteShellSandboxSession,
  type RemoteShellCommandSpec,
  type RemoteShellSandboxSession,
  type RemoteShellSessionOptions,
} from "../agents/sandbox/remote-shell-transport.js";
