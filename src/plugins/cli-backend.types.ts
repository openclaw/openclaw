/** Type contracts for plugin-owned CLI backend integrations. */
import type { CliBackendConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineHostCapability } from "../context-engine/types.js";

export type PluginTextReplacement = {
  from: string | RegExp;
  to: string;
};

export type PluginTextTransforms = {
  /** Rewrites applied to outbound prompt text before provider/CLI transport. */
  input?: PluginTextReplacement[];
  /** Rewrites applied to inbound assistant text before OpenClaw consumes it. */
  output?: PluginTextReplacement[];
};

export type CliBundleMcpMode =
  | "claude-config-file"
  | "codex-config-overrides"
  | "gemini-system-settings";

export type CliBackendPrepareExecutionContext = {
  config?: OpenClawConfig;
  workspaceDir: string;
  agentDir?: string;
  provider: string;
  modelId: string;
  authProfileId?: string;
};

export type CliBackendPreparedExecution = {
  env?: Record<string, string>;
  clearEnv?: string[];
  cleanup?: () => Promise<void>;
};

export type CliBackendThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export type CliBackendResolveExecutionArgsContext = {
  config?: OpenClawConfig;
  workspaceDir: string;
  provider: string;
  modelId: string;
  authProfileId?: string;
  thinkingLevel?: CliBackendThinkingLevel;
  useResume: boolean;
  baseArgs: readonly string[];
};

export type CliBackendResolveExecutionArgs = (
  ctx: CliBackendResolveExecutionArgsContext,
) => readonly string[] | null | undefined;

export type CliBackendAuthEpochMode = "combined" | "profile-only";

export type CliBackendNativeToolMode = "none" | "always-on";

/** Token-usage estimate returned by a backend-owned heuristic estimator. */
export type CliBackendUsageEstimate = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

/** Inputs given to a backend's `estimateUsage` hook for a single CLI turn. */
export type CliBackendEstimateUsageContext = {
  /** Final prompt text sent to the CLI subprocess (post-textTransforms.input). */
  promptText: string;
  /** Assistant text parsed from the CLI subprocess stdout. */
  assistantText: string;
  /** Model id used for this turn (post-alias resolution). */
  modelId: string;
};

export type CliBackendNormalizeConfigContext = {
  config?: OpenClawConfig;
  backendId: string;
  agentId?: string;
};

/** Plugin-owned CLI backend defaults used by the text-only CLI runner. */
export type CliBackendPlugin = {
  /** Provider id used in model refs, for example `claude-cli/opus`. */
  id: string;
  /** Canonical model provider whose models this CLI backend can execute. */
  modelProvider?: string;
  /** Default backend config before user overrides from `agents.defaults.cliBackends`. */
  config: CliBackendConfig;
  /**
   * Context-engine host capabilities provided by this backend when it is
   * driven through the generic CLI runner.
   */
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  /**
   * Backend-owned compaction for non-harness CLI sessions.
   * Set only when the backend bounds its own transcript and persists resumable state.
   */
  ownsNativeCompaction?: boolean;
  /**
   * Optional live-smoke metadata owned by the backend plugin.
   *
   * Keep provider-specific test wiring here instead of scattering it across
   * Docker wrappers, docs, and gateway live tests.
   */
  liveTest?: {
    defaultModelRef?: string;
    defaultImageProbe?: boolean;
    defaultMcpProbe?: boolean;
    docker?: {
      npmPackage?: string;
      binaryName?: string;
    };
  };
  /**
   * Whether OpenClaw should inject bundle MCP config for this backend.
   *
   * Keep this opt-in. Only backends that explicitly consume OpenClaw's bundle
   * MCP bridge should enable it.
   */
  bundleMcp?: boolean;
  /**
   * Provider-owned bundle MCP integration strategy.
   *
   * Different CLIs wire MCP through different surfaces:
   * - Claude: `--strict-mcp-config --mcp-config`
   * - Codex: `-c mcp_servers=...`
   * - Gemini: system-level `settings.json`
   */
  bundleMcpMode?: CliBundleMcpMode;
  /**
   * Optional config normalizer applied after user overrides merge.
   *
   * Use this for backend-specific compatibility rewrites when old config
   * shapes need to stay working.
   */
  normalizeConfig?: (
    config: CliBackendConfig,
    context?: CliBackendNormalizeConfigContext,
  ) => CliBackendConfig;
  /**
   * Backend-owned final system-prompt transform.
   *
   * Use this for tiny CLI-specific compatibility rewrites without replacing
   * the generic CLI runner or prompt builder.
   */
  transformSystemPrompt?: (ctx: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    modelDisplay: string;
    agentId?: string;
    systemPrompt: string;
  }) => string | null | undefined;
  /**
   * Backend-owned bidirectional text replacements.
   *
   * `input` applies to the system prompt and user prompt passed to the CLI.
   * `output` applies to parsed/streamed assistant text from the CLI.
   */
  textTransforms?: PluginTextTransforms;
  /**
   * Preferred auth-profile id when the caller did not explicitly lock one.
   *
   * Use this when the backend should consume a canonical OpenClaw auth profile
   * rather than ambient host auth by default.
   */
  defaultAuthProfileId?: string;
  /**
   * Session/auth epoch source policy.
   *
   * `combined` keeps the legacy "host credential + auth profile" fingerprint.
   * `profile-only` treats the selected OpenClaw auth profile as the sole auth
   * owner for session invalidation when one is present.
   */
  authEpochMode?: CliBackendAuthEpochMode;
  /**
   * Backend-owned execution bridge.
   *
   * Use this on async run paths when the backend needs a generated auth/config
   * bridge (for example a private CLI home directory) without teaching the core
   * runner about provider-specific file formats.
   */
  prepareExecution?: (
    ctx: CliBackendPrepareExecutionContext,
  ) =>
    | Promise<CliBackendPreparedExecution | null | undefined>
    | CliBackendPreparedExecution
    | null
    | undefined;
  /**
   * Backend-owned per-run argv rewrite.
   *
   * Use this for request-scoped CLI dialect flags that should not be modeled
   * as static config, such as mapping OpenClaw thinking levels to a backend's
   * native effort flag.
   */
  resolveExecutionArgs?: CliBackendResolveExecutionArgs;
  /**
   * Whether this CLI backend can expose native tools outside OpenClaw's tool
   * catalog. Backends that cannot provide a true no-tools mode must mark
   * themselves as `always-on` so callers that require disabled tools fail
   * closed instead of launching a native harness.
   */
  nativeToolMode?: CliBackendNativeToolMode;
  /**
   * Backend-owned token-usage estimator for text-output backends that cannot
   * surface structured usage on stdout.
   *
   * Called by the CLI runner after a successful turn when the parsed output
   * carries no `usage` field. Return `undefined` to leave usage unset.
   *
   * Heuristics live in the backend so the core runner stays
   * tokenizer-agnostic. Example: a Gemini-targeted backend can apply Google's
   * official "1 token ≈ 4 characters" rule without pulling a 100+ MB
   * SentencePiece vocab into the bundle.
   */
  estimateUsage?: (ctx: CliBackendEstimateUsageContext) => CliBackendUsageEstimate | undefined;
};
