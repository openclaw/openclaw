import type {
  ContextEngine,
  ContextEngineHostCapability,
  ContextEngineOperation,
} from "./types.js";

export type ContextEngineHostSupport = {
  id: string;
  label: string;
  capabilities: readonly ContextEngineHostCapability[];
};

export const GENERIC_CLI_CONTEXT_ENGINE_HOST_CAPABILITIES = [
  "bootstrap",
  "after-turn",
  "maintain",
] as const satisfies readonly ContextEngineHostCapability[];

export const PI_EMBEDDED_CONTEXT_ENGINE_HOST = {
  id: "pi-embedded",
  label: "Pi embedded runner",
  capabilities: [
    "bootstrap",
    "assemble-before-prompt",
    "after-turn",
    "maintain",
    "compact",
    "runtime-llm-complete",
  ],
} as const satisfies ContextEngineHostSupport;

export const CODEX_APP_SERVER_CONTEXT_ENGINE_HOST = {
  id: "codex-app-server",
  label: "Codex app-server harness",
  capabilities: [
    "bootstrap",
    "assemble-before-prompt",
    "after-turn",
    "maintain",
    "compact",
    "runtime-llm-complete",
    "thread-bootstrap-projection",
  ],
} as const satisfies ContextEngineHostSupport;

/** Build the default host support advertised by the generic CLI runner. */
export function buildGenericCliContextEngineHostSupport(params: {
  backendId: string;
  capabilities?: readonly ContextEngineHostCapability[];
}): ContextEngineHostSupport {
  return {
    id: `cli:${params.backendId}`,
    label: `CLI backend "${params.backendId}"`,
    capabilities: params.capabilities ?? GENERIC_CLI_CONTEXT_ENGINE_HOST_CAPABILITIES,
  };
}

/** Assert that a context engine can safely run under the supplied host. */
export function assertContextEngineHostSupport(params: {
  contextEngine: ContextEngine;
  operation: ContextEngineOperation;
  host: ContextEngineHostSupport;
}): void {
  const requirements = params.contextEngine.info.hostRequirements?.[params.operation];
  if (!requirements || requirements.requiredCapabilities.length === 0) {
    return;
  }

  const supported = new Set(params.host.capabilities);
  const missing = requirements.requiredCapabilities.filter(
    (capability) => !supported.has(capability),
  );
  if (missing.length === 0) {
    return;
  }

  const engineId = params.contextEngine.info.id;
  const required = requirements.requiredCapabilities.join(", ");
  const actual =
    params.host.capabilities.length > 0 ? params.host.capabilities.join(", ") : "(none)";
  const guidance = requirements.unsupportedMessage ? ` ${requirements.unsupportedMessage}` : "";
  throw new Error(
    `Context engine "${engineId}" cannot run operation "${params.operation}" on ${params.host.label}. ` +
      `Missing host capabilities: ${missing.join(", ")}. ` +
      `Required capabilities: ${required}. ` +
      `Host capabilities: ${actual}.${guidance}`,
  );
}
