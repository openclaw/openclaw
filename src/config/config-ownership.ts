// Resolves whether OpenClaw or an external deployment owns config persistence.
import { resolveIsNixMode } from "./paths.js";

/** Host-only switch for config rendered by GitOps or another external manager. */
export const OPENCLAW_CONFIG_MANAGED_ENV = "OPENCLAW_CONFIG_MANAGED";

export type ConfigOwnership =
  | { mode: "mutable"; owner: "openclaw" }
  | { mode: "managed"; owner: "external" | "nix" };

/** Resolve config ownership from host environment only. */
export function resolveConfigOwnership(env: NodeJS.ProcessEnv = process.env): ConfigOwnership {
  if (resolveIsNixMode(env)) {
    return { mode: "managed", owner: "nix" };
  }
  if (env[OPENCLAW_CONFIG_MANAGED_ENV] === "1") {
    return { mode: "managed", owner: "external" };
  }
  return { mode: "mutable", owner: "openclaw" };
}

/** Return whether the host declares config externally managed and immutable. */
export function resolveIsConfigManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConfigOwnership(env).mode === "managed";
}

/** Error thrown when a mutating config path targets externally managed config. */
export class ManagedConfigMutationError extends Error {
  readonly code = "OPENCLAW_CONFIG_MANAGED";

  constructor(params: { configPath?: string } = {}) {
    super(formatManagedConfigMutationMessage(params));
    this.name = "ManagedConfigMutationError";
  }
}

function formatManagedConfigMutationMessage(params: { configPath?: string } = {}): string {
  return [
    "Config is externally managed (`OPENCLAW_CONFIG_MANAGED=1`), so OpenClaw treats openclaw.json as immutable.",
    ...(params.configPath ? [`Config path: ${params.configPath}`] : []),
    "Do not run setup, onboarding, plugin install/update/uninstall/enable, doctor repair/token-generation, or config writes against this file.",
    "Edit the external deployment source instead, then let its config update propagate to OpenClaw.",
  ].join("\n");
}
