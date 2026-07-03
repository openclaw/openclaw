// Guards config writes that are disallowed in Nix-managed installs.
import { resolveIsNixMode } from "./paths.js";

/** Agent-first Nix install docs shown when runtime config writes are blocked. */
export const NIX_OPENCLAW_AGENT_FIRST_URL = "https://github.com/openclaw/nix-openclaw#quick-start";
/** Public OpenClaw Nix overview shown with immutable-config errors. */
export const OPENCLAW_NIX_OVERVIEW_URL = "https://docs.openclaw.ai/install/nix";

/** Error thrown when a mutating config path is attempted while Nix owns config state. */
export class NixModeConfigMutationError extends Error {
  readonly code = "OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE";

  constructor(params: { configPath?: string; operation?: string } = {}) {
    super(formatNixModeConfigMutationMessage(params));
    this.name = "NixModeConfigMutationError";
  }
}

/** Build the operator-facing immutable-config message for Nix-managed installs. */
export function formatNixModeConfigMutationMessage(
  params: {
    configPath?: string;
    operation?: string;
  } = {},
): string {
  const operationHint = params.operation ? `Operation: ${params.operation}` : "";
  return [
    "Config is managed by Nix (`OPENCLAW_NIX_MODE=1`), so OpenClaw treats openclaw.json as immutable.",
    "This usually means nix-openclaw, the first-party Nix distribution, or another Nix-managed package set this mode.",
    ...(params.configPath ? [`Config path: ${params.configPath}`] : []),
    ...(operationHint ? [operationHint] : []),
    "Do not run config-mutating operations such as setup, onboarding, openclaw update, plugin install/update/uninstall/enable, doctor --generate-gateway-token, or config set against this file.",
    "In Nix mode, doctor --fix/--repair/--yes may still run non-config repairs (for example session/legacy state migrations or permission fixes), but any step that tries to modify this file will fail.",
    "Edit the Nix source for this install instead. For nix-openclaw, edit `programs.openclaw.config` or `instances.<name>.config`, then rebuild with Home Manager or NixOS.",
    `Agent-first Nix setup: ${NIX_OPENCLAW_AGENT_FIRST_URL}`,
    `OpenClaw Nix overview: ${OPENCLAW_NIX_OVERVIEW_URL}`,
  ].join("\n");
}

/**
 * Throw when the current environment marks OpenClaw config as Nix-managed and immutable.
 *
 * @param params.configPath - The config file path being mutated (if known)
 * @param params.env - Environment variables to check for OPENCLAW_NIX_MODE
 * @param params.operation - Description of the operation being performed (for better error messages)
 */
export function assertConfigWriteAllowedInCurrentMode(
  params: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    operation?: string;
  } = {},
): void {
  if (!resolveIsNixMode(params.env)) {
    return;
  }
  // In Nix mode, all writes must happen in the declarative source and then rebuild.
  // The caller is responsible for only invoking this guard at actual openclaw.json write points;
  // non-config repairs (session/legacy state, permission fixes) do not call it.
  throw new NixModeConfigMutationError({
    configPath: params.configPath,
    operation: params.operation,
  });
}
