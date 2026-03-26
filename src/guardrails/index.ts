export type {
  GuardrailProvider,
  GuardrailRequest,
  GuardrailDecision,
  GuardrailReason,
  GuardrailsConfig,
  GuardrailProviderConfig,
} from "./types.js";
export { AllowlistProvider } from "./builtin.js";
export { initGuardrailsFromConfig } from "./init.js";

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GuardrailProvider, GuardrailProviderConfig, GuardrailRequest } from "./types.js";
import { AllowlistProvider } from "./builtin.js";

/** Load a GuardrailProvider from config. Called once at startup. */
export async function loadGuardrailProvider(providerConfig: GuardrailProviderConfig): Promise<GuardrailProvider> {
  const { use, config: opts } = providerConfig;

  if (use === "builtin:allowlist") {
    return new AllowlistProvider(opts as { allowedTools?: string[]; deniedTools?: string[] });
  }

  // Resolve local paths (./foo.js) relative to cwd, not this module.
  const specifier = use.startsWith("./") || use.startsWith("../")
    ? pathToFileURL(path.resolve(process.cwd(), use)).href
    : use;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to load guardrail provider '${use}': ${err instanceof Error ? err.message : String(err)}`);
  }

  const ProviderClass = (mod.default ?? mod.GuardrailProvider) as
    | (new (config?: Record<string, unknown>) => GuardrailProvider)
    | undefined;

  if (!ProviderClass || typeof ProviderClass !== "function") {
    throw new Error(`Module '${use}' does not export a default constructor or named GuardrailProvider`);
  }

  const provider = new ProviderClass(opts);

  if (typeof provider.evaluate !== "function" || typeof provider.name !== "string") {
    throw new Error(`Module '${use}' does not implement GuardrailProvider (missing evaluate() or name)`);
  }

  return provider;
}

/**
 * Evaluate a tool call against a provider.
 * Returns { block, blockReason } compatible with before_tool_call hook shape.
 */
export async function evaluateGuardrail(
  provider: GuardrailProvider,
  event: { toolName: string; params: Record<string, unknown>; agentId?: string; sessionId?: string; runId?: string; toolCallId?: string },
  failClosed: boolean,
): Promise<{ block: boolean; blockReason?: string }> {
  const request: GuardrailRequest = {
    toolName: event.toolName,
    toolInput: event.params,
    agentId: event.agentId,
    sessionId: event.sessionId,
    runId: event.runId,
    toolCallId: event.toolCallId,
    timestamp: new Date().toISOString(),
  };

  try {
    const decision = await provider.evaluate(request);
    if (!decision.allow) {
      const reason = decision.reasons?.[0]?.message ?? "blocked by guardrail policy";
      return { block: true, blockReason: `Guardrail (${provider.name}): ${reason}` };
    }
    return { block: false };
  } catch (err) {
    // Propagate error message so agent/user can diagnose and fix config.
    if (failClosed) {
      const message = err instanceof Error ? err.message : String(err);
      return { block: true, blockReason: `Guardrail (${provider.name}): provider error (fail-closed): ${message}` };
    }
    return { block: false };
  }
}
