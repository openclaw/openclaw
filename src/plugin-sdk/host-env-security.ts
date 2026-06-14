// Focused public SDK subpath for host execution-environment sanitization.
// App-server extensions that spawn a local bridge binary (claude, codex, …)
// must route the inherited host env + config-derived overrides through the
// canonical sanitizer so dangerous keys (LD_PRELOAD, NODE_OPTIONS, PATH, …)
// cannot be injected from workspace config. Prefer this over re-implementing
// the denylist per extension.
export {
  inspectHostExecEnvOverrides,
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  isDangerousHostInheritedEnvVarName,
  normalizeEnvVarKey,
  normalizeHostOverrideEnvVarKey,
  sanitizeHostExecEnv,
  sanitizeHostExecEnvWithDiagnostics,
  sanitizeSystemRunEnvOverrides,
} from "../infra/host-env-security.js";
