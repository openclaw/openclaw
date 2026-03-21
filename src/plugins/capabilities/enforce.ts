/**
 * Capability enforcement helpers.
 *
 * These create gated proxies and stubs that silently block registration/runtime
 * calls when a plugin lacks the required capability.
 *
 * Phase 1: warn-only mode (log diagnostics, don't block).
 * Phase 2+: configurable enforcement.
 */

import type { PluginRuntime } from "../runtime/types.js";
import type {
  PluginRegisterCapability,
  PluginRuntimeCapability,
  ResolvedCapabilities,
} from "./types.js";

export type CapabilityEnforcementMode = "warn" | "enforce";

export type CapabilityDiagnostic = {
  pluginId: string;
  type: "register" | "runtime";
  capability: string;
  action: "blocked" | "warned";
};

type DiagnosticCallback = (diagnostic: CapabilityDiagnostic) => void;

/**
 * Map from OpenClawPluginApi registration method names to their required capability.
 */
export const REGISTER_METHOD_CAPABILITIES: Record<string, PluginRegisterCapability> = {
  registerTool: "tool",
  registerHook: "hook",
  registerHttpRoute: "httpRoute",
  registerChannel: "channel",
  registerProvider: "provider",
  registerSpeechProvider: "speechProvider",
  registerMediaUnderstandingProvider: "mediaUnderstandingProvider",
  registerImageGenerationProvider: "imageGenerationProvider",
  registerWebSearchProvider: "webSearchProvider",
  registerGatewayMethod: "gatewayMethod",
  registerCli: "cli",
  registerService: "service",
  registerInteractiveHandler: "interactive",
  registerCommand: "command",
};

/**
 * Map from PluginRuntime property names to their required runtime capability.
 */
export const RUNTIME_PROPERTY_CAPABILITIES: Record<string, PluginRuntimeCapability> = {
  config: "config.read",
  agent: "agent",
  subagent: "subagent",
  system: "system",
  media: "media",
  tts: "tts",
  stt: "stt",
  tools: "tools",
  channel: "channel",
  events: "events",
  logging: "logging",
  state: "state",
  modelAuth: "modelAuth",
};

/**
 * Create a gated registration function that checks capabilities before calling through.
 *
 * In warn mode: logs diagnostic but calls through.
 * In enforce mode: logs diagnostic and returns a no-op.
 */
// Generic function wrapper — `any` in the constraint is required so TypeScript
// preserves contextual parameter types at each call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function gateRegistration<T extends (...args: any[]) => any>(
  pluginId: string,
  methodName: string,
  original: T,
  capabilities: ResolvedCapabilities,
  opts?: {
    mode?: CapabilityEnforcementMode;
    onDiagnostic?: DiagnosticCallback;
  },
): T {
  if (capabilities.isUnrestricted) {
    return original;
  }

  const requiredCap = REGISTER_METHOD_CAPABILITIES[methodName];
  if (!requiredCap || capabilities.hasRegister(requiredCap)) {
    return original;
  }

  const mode = opts?.mode ?? "warn";

  return ((...args: unknown[]) => {
    const diagnostic: CapabilityDiagnostic = {
      pluginId,
      type: "register",
      capability: requiredCap,
      action: mode === "enforce" ? "blocked" : "warned",
    };
    opts?.onDiagnostic?.(diagnostic);

    if (mode === "warn") {
      return original(...args);
    }
    // Enforce mode: silently drop the registration.
  }) as T;
}

/**
 * Create a gated runtime proxy that checks capabilities before property access.
 *
 * In warn mode: logs diagnostic but allows access.
 * In enforce mode: returns undefined for blocked properties.
 */
export function gateRuntime(
  pluginId: string,
  runtime: PluginRuntime,
  capabilities: ResolvedCapabilities,
  opts?: {
    mode?: CapabilityEnforcementMode;
    onDiagnostic?: DiagnosticCallback;
  },
): PluginRuntime {
  if (capabilities.isUnrestricted) {
    return runtime;
  }

  const mode = opts?.mode ?? "warn";

  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }

      const requiredCap = RUNTIME_PROPERTY_CAPABILITIES[prop];
      if (!requiredCap) {
        // Not a gated property (e.g. "version"), allow through.
        return Reflect.get(target, prop, receiver);
      }

      if (capabilities.hasRuntime(requiredCap)) {
        return Reflect.get(target, prop, receiver);
      }

      const diagnostic: CapabilityDiagnostic = {
        pluginId,
        type: "runtime",
        capability: requiredCap,
        action: mode === "enforce" ? "blocked" : "warned",
      };
      opts?.onDiagnostic?.(diagnostic);

      if (mode === "warn") {
        return Reflect.get(target, prop, receiver);
      }

      // Enforce mode: return undefined for blocked properties.
      return undefined;
    },
  });
}
