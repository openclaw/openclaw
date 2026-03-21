/**
 * Plugin capability type definitions.
 *
 * Capabilities are declared in openclaw.plugin.json and control what
 * a plugin can register and which runtime namespaces it can access.
 */

/**
 * Registration capabilities — what types of registrations a plugin can make.
 *
 * Maps to the `registerXxx` methods on OpenClawPluginApi.
 */
export type PluginRegisterCapability =
  | "channel"
  | "provider"
  | "speechProvider"
  | "mediaUnderstandingProvider"
  | "imageGenerationProvider"
  | "webSearchProvider"
  | "tool"
  | "hook"
  | "httpRoute"
  | "gatewayMethod"
  | "cli"
  | "service"
  | "interactive"
  | "command";

/**
 * Runtime capabilities — which runtime namespace properties a plugin can access.
 *
 * Maps to the keys on PluginRuntime.
 */
export type PluginRuntimeCapability =
  | "config.read"
  | "config.write"
  | "agent"
  | "subagent"
  | "system"
  | "media"
  | "tts"
  | "stt"
  | "tools"
  | "channel"
  | "events"
  | "logging"
  | "state"
  | "modelAuth";

/** Wildcard capability indicating full/unrestricted access. */
export const CAPABILITY_WILDCARD = "*" as const;

/**
 * Declared capability set from a plugin manifest.
 *
 * When absent (undefined), the plugin gets full access (backward compatible).
 */
export type PluginCapabilities = {
  /** Registration capabilities. Defaults to ["*"] (all). */
  register?: Array<PluginRegisterCapability | typeof CAPABILITY_WILDCARD>;
  /** Runtime namespace capabilities. Defaults to ["*"] (all). */
  runtime?: Array<PluginRuntimeCapability | typeof CAPABILITY_WILDCARD>;
};

/**
 * Resolved capability set after merging manifest declarations with user overrides.
 * The `has*` methods provide efficient capability checks.
 */
export type ResolvedCapabilities = {
  /** Check if a registration capability is allowed. */
  hasRegister(cap: PluginRegisterCapability): boolean;
  /** Check if a runtime capability is allowed. */
  hasRuntime(cap: PluginRuntimeCapability): boolean;
  /** Whether this is a full-access (wildcard) capability set. */
  isUnrestricted: boolean;
  /** Raw register capabilities for diagnostics. */
  registerCaps: ReadonlySet<string>;
  /** Raw runtime capabilities for diagnostics. */
  runtimeCaps: ReadonlySet<string>;
};

/** All valid registration capability names. */
export const ALL_REGISTER_CAPABILITIES: readonly PluginRegisterCapability[] = [
  "channel",
  "cli",
  "command",
  "gatewayMethod",
  "hook",
  "httpRoute",
  "imageGenerationProvider",
  "interactive",
  "mediaUnderstandingProvider",
  "provider",
  "service",
  "speechProvider",
  "tool",
  "webSearchProvider",
] as const;

/** All valid runtime capability names. */
export const ALL_RUNTIME_CAPABILITIES: readonly PluginRuntimeCapability[] = [
  "agent",
  "channel",
  "config.read",
  "config.write",
  "events",
  "logging",
  "media",
  "modelAuth",
  "state",
  "stt",
  "subagent",
  "system",
  "tools",
  "tts",
] as const;
