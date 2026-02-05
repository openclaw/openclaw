/**
 * Runtime Resolver for the Agent Execution Layer.
 *
 * Centralizes all runtime selection logic into a single service. The resolver
 * determines which runtime to use and builds RuntimeContext metadata. It does NOT
 * instantiate actual runtimes - that happens in Phase 4 (TurnExecutor).
 *
 * Consolidates logic previously scattered across:
 * - resolveSessionRuntimeKind() in src/agents/main-agent-runtime-factory.ts
 * - Runtime branching in src/commands/agent.ts
 * - Runtime selection in src/auto-reply/reply/agent-runner-execution.ts
 *
 * @see docs/design/plans/opus/01-agent-execution-layer.md
 */

import type { SandboxContext as SandboxContextFull } from "../agents/sandbox/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type {
  ExecutionRequest,
  RuntimeContext,
  RuntimeCapabilities,
  ToolPolicy,
  SandboxContext,
} from "./types.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { isCliProvider } from "../agents/model-selection.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import { expandToolGroups, resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { supportsXHighThinking } from "../auto-reply/thinking.js";
import {
  DEFAULT_AGENT_ID,
  isSubagentSessionKey,
  normalizeAgentId,
} from "../routing/session-key.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * RuntimeResolver interface for determining runtime configuration.
 */
export interface RuntimeResolver {
  /**
   * Resolve runtime context for an execution request.
   *
   * @param request - The execution request
   * @returns Resolved runtime context with kind, provider, model, tools, sandbox, and capabilities
   */
  resolve(request: ExecutionRequest): Promise<RuntimeContext>;
}

/**
 * Logger interface for RuntimeResolver.
 */
export type RuntimeResolverLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Options for creating a RuntimeResolver.
 */
export interface RuntimeResolverOptions {
  /** Optional logger for debug output. */
  logger?: RuntimeResolverLogger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Default RuntimeResolver implementation.
 *
 * Resolution order for runtime kind:
 * 1. Explicit runtimeKind in request (highest priority)
 * 2. CLI provider detection (provider is a CLI provider)
 * 3. Subagent inheritance (check per-agent and global subagent config)
 * 4. Per-agent configuration
 * 5. Main agent special handling (mainRuntime config)
 * 6. Global default
 * 7. Fallback to "pi"
 */
export class DefaultRuntimeResolver implements RuntimeResolver {
  private logger?: RuntimeResolverLogger;

  constructor(options: RuntimeResolverOptions = {}) {
    this.logger = options.logger;
  }

  async resolve(request: ExecutionRequest): Promise<RuntimeContext> {
    const config = request.config;
    const agentId = normalizeAgentId(request.agentId);

    // Step 1: Resolve provider and model first (needed for CLI detection)
    const { provider, model } = this.resolveProviderAndModel(config, agentId);

    // Step 2: Resolve runtime kind (may depend on provider for CLI detection)
    const kind = this.resolveRuntimeKind(config, agentId, provider, request);

    // Step 3: Resolve tool policy
    const toolPolicy = this.resolveToolPolicy(config, agentId, request);

    // Step 4: Resolve sandbox (only if tools enabled)
    const sandbox = toolPolicy.enabled ? await this.resolveSandbox(request) : null;

    // Step 5: Resolve capabilities
    const capabilities = this.resolveCapabilities(kind, provider, model);

    this.logger?.debug?.(
      `[RuntimeResolver] resolved: kind=${kind} provider=${provider} model=${model} tools=${toolPolicy.enabled}`,
    );

    return {
      kind,
      provider,
      model,
      toolPolicy,
      sandbox,
      capabilities,
    };
  }

  // ---------------------------------------------------------------------------
  // Runtime Kind Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the runtime kind for execution.
   *
   * Resolution order:
   * 1. Explicit runtimeKind in request (highest priority)
   * 2. CLI provider detection
   * 3. Subagent inheritance
   * 4. Per-agent configuration
   * 5. Main agent special handling
   * 6. Global default
   * 7. Fallback to "pi"
   */
  private resolveRuntimeKind(
    config: OpenClawConfig | undefined,
    agentId: string,
    provider: string,
    request: ExecutionRequest,
  ): "pi" | "claude" | "cli" {
    // 1. Check explicit runtimeKind in request (highest priority)
    if (request.runtimeKind) {
      this.logger?.debug?.(`[RuntimeResolver] using explicit runtimeKind: ${request.runtimeKind}`);
      return request.runtimeKind;
    }

    // 2. Check if provider is a CLI provider
    if (isCliProvider(provider, config)) {
      this.logger?.debug?.(`[RuntimeResolver] detected CLI provider: ${provider}`);
      return "cli";
    }

    if (!config) {
      return "pi";
    }

    const sessionKey = request.sessionKey;
    const isSubagent = sessionKey ? isSubagentSessionKey(sessionKey) : false;

    // 3. For subagents, check inheritance
    if (isSubagent) {
      const subagentKind = this.resolveSubagentRuntimeKind(config, agentId);
      if (subagentKind) {
        this.logger?.debug?.(`[RuntimeResolver] subagent runtime from config: ${subagentKind}`);
        return subagentKind;
      }
      // Fall through to parent agent's runtime
    }

    // 4. Check per-agent override
    const agentConfig = resolveAgentConfig(config, agentId);
    if (agentConfig?.runtime) {
      const agentRuntime = agentConfig.runtime === "claude" ? "claude" : "pi";
      this.logger?.debug?.(`[RuntimeResolver] per-agent runtime: ${agentRuntime}`);
      return agentRuntime;
    }

    // 5. For main agent, use mainRuntime logic
    if (agentId === DEFAULT_AGENT_ID) {
      const mainRuntime = this.resolveMainAgentRuntime(config);
      this.logger?.debug?.(`[RuntimeResolver] main agent runtime: ${mainRuntime}`);
      return mainRuntime;
    }

    // 6. Use global default
    const globalRuntime = config.agents?.defaults?.runtime;
    if (globalRuntime) {
      const resolved = globalRuntime === "claude" ? "claude" : "pi";
      this.logger?.debug?.(`[RuntimeResolver] global default runtime: ${resolved}`);
      return resolved;
    }

    // 7. Fallback
    return "pi";
  }

  /**
   * Resolve subagent-specific runtime configuration.
   * Returns undefined if subagent should inherit parent runtime.
   */
  private resolveSubagentRuntimeKind(
    config: OpenClawConfig,
    agentId: string,
  ): "pi" | "claude" | undefined {
    // Check per-agent subagent runtime config
    const agentConfig = resolveAgentConfig(config, agentId);
    const subagentRuntime = agentConfig?.subagents?.runtime;
    if (subagentRuntime && subagentRuntime !== "inherit") {
      return subagentRuntime === "claude" ? "claude" : "pi";
    }

    // Check global subagent runtime defaults
    const globalSubagentRuntime = config.agents?.defaults?.subagents?.runtime;
    if (globalSubagentRuntime && globalSubagentRuntime !== "inherit") {
      return globalSubagentRuntime === "claude" ? "claude" : "pi";
    }

    // Inherit from parent (return undefined)
    return undefined;
  }

  /**
   * Resolve runtime for the main agent.
   */
  private resolveMainAgentRuntime(config: OpenClawConfig): "pi" | "claude" {
    const mainRuntime =
      config.agents?.defaults?.mainRuntime ??
      config.agents?.main?.runtime ??
      config.agents?.defaults?.runtime;
    return mainRuntime === "claude" ? "claude" : "pi";
  }

  // ---------------------------------------------------------------------------
  // Provider and Model Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve provider and model from config.
   */
  private resolveProviderAndModel(
    config: OpenClawConfig | undefined,
    agentId: string,
  ): { provider: string; model: string } {
    if (!config) {
      return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
    }

    // Use existing model resolution logic
    const ref = resolveDefaultModelForAgent({ cfg: config, agentId });
    return {
      provider: ref.provider,
      model: ref.model,
    };
  }

  // ---------------------------------------------------------------------------
  // Tool Policy Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve tool policy from config.
   *
   * Resolution order:
   * 1. Get base profile (global or per-agent)
   * 2. Apply config allow/deny lists
   * 3. Merge with channel/provider overrides (future)
   */
  private resolveToolPolicy(
    config: OpenClawConfig | undefined,
    agentId: string,
    _request: ExecutionRequest,
  ): ToolPolicy {
    if (!config) {
      // Default: tools enabled, no restrictions, elevated allowed
      return { enabled: true, allowElevated: true };
    }

    const toolsCfg = config.tools;
    const agentCfg = resolveAgentConfig(config, agentId);
    const agentToolsCfg = agentCfg?.tools;

    // Get base profile
    const profileId = agentToolsCfg?.profile ?? toolsCfg?.profile;
    const profilePolicy = resolveToolProfilePolicy(profileId);

    // Collect all allow lists (profile + global + agent + alsoAllow)
    const allowLists: Array<string[] | undefined> = [
      profilePolicy?.allow,
      toolsCfg?.allow,
      toolsCfg?.alsoAllow,
      agentToolsCfg?.allow,
      agentToolsCfg?.alsoAllow,
    ];

    const filteredAllowLists = allowLists.filter(
      (list): list is string[] => Array.isArray(list) && list.length > 0,
    );

    const allowList =
      filteredAllowLists.length > 0
        ? expandToolGroups([...new Set(filteredAllowLists.flat())])
        : undefined;

    // Collect all deny lists
    const denyLists: Array<string[] | undefined> = [
      profilePolicy?.deny,
      toolsCfg?.deny,
      agentToolsCfg?.deny,
    ];

    const filteredDenyLists = denyLists.filter(
      (list): list is string[] => Array.isArray(list) && list.length > 0,
    );

    const denyList =
      filteredDenyLists.length > 0
        ? expandToolGroups([...new Set(filteredDenyLists.flat())])
        : undefined;

    // Resolve elevated permission
    const elevatedEnabled = agentToolsCfg?.elevated?.enabled ?? toolsCfg?.elevated?.enabled ?? true;

    return {
      enabled: true,
      allowList,
      denyList,
      allowElevated: elevatedEnabled,
    };
  }

  // ---------------------------------------------------------------------------
  // Sandbox Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve sandbox context for the request.
   * Delegates to existing resolveSandboxContext() implementation.
   */
  private async resolveSandbox(request: ExecutionRequest): Promise<SandboxContext | null> {
    const fullContext = await resolveSandboxContext({
      config: request.config,
      sessionKey: request.sessionKey,
      workspaceDir: request.workspaceDir,
    });

    if (!fullContext) {
      return null;
    }

    // Map the full sandbox context to our simplified SandboxContext type
    return this.mapSandboxContext(fullContext);
  }

  /**
   * Map full SandboxContext to the simplified execution layer type.
   */
  private mapSandboxContext(full: SandboxContextFull): SandboxContext {
    return {
      type: "docker",
      containerId: full.containerName,
      workDir: full.containerWorkdir,
    };
  }

  // ---------------------------------------------------------------------------
  // Capabilities Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve runtime capabilities based on runtime kind and model.
   */
  private resolveCapabilities(
    kind: "pi" | "claude" | "cli",
    provider: string,
    model: string,
  ): RuntimeCapabilities {
    return {
      supportsTools: kind !== "cli",
      supportsStreaming: kind !== "cli",
      supportsImages: kind !== "cli", // Conservative default
      supportsThinking: supportsXHighThinking(provider, model),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Create a RuntimeResolver instance.
 *
 * @param options - Resolver options
 * @returns RuntimeResolver instance
 */
export function createRuntimeResolver(options?: RuntimeResolverOptions): RuntimeResolver {
  return new DefaultRuntimeResolver(options);
}
