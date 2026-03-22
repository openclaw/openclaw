import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
  SandboxSshSettings,
} from "./types.sandbox.js";

/**
 * HTTP status codes that should trigger model fallback.
 * Default behavior triggers fallback on server errors, rate limits, timeouts, and not-found errors.
 * Users can extend this to include all client errors with "all" or specify custom codes.
 */
export type FallbackOnErrorCodes =
  | "all" // All HTTP errors (4xx and 5xx) trigger fallback
  | "default" // Server errors (500, 502, 503, 504) + rate limits (429) + timeout (408) + not found (404)
  | number[]; // Custom list of HTTP status codes

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
      /**
       * HTTP status codes that should trigger fallback to next model.
       * - "default": Server errors (500, 502, 503, 504) + rate limits (429) + timeout (408) + not found (404) [default]
       * - "all": All HTTP errors (4xx and 5xx) trigger fallback
       * - number[]: Custom list of status codes (e.g., [400, 401, 403, 429, 500, 502, 503])
       *
       * @example
       * // Enable fallback on all client and server errors
       * { primary: "openai/gpt-4", fallbacks: ["anthropic/claude-3"], fallbackOnErrors: "all" }
       *
       * @example
       * // Custom error codes
       * { primary: "openai/gpt-4", fallbacks: ["anthropic/claude-3"], fallbackOnErrors: [400, 429, 500, 502, 503] }
       */
      fallbackOnErrors?: FallbackOnErrorCodes;
    };

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
  /** Sandbox runtime backend id. Default: "docker". */
  backend?: string;
  /** Agent workspace access inside the sandbox. */
  workspaceAccess?: "none" | "ro" | "rw";
  /**
   * Session tools visibility for sandboxed sessions.
   * - "spawned": only allow session tools to target sessions spawned from this session (default)
   * - "all": allow session tools to target any session
   */
  sessionToolsVisibility?: "spawned" | "all";
  /** Container/workspace scope for sandbox isolation. */
  scope?: "session" | "agent" | "shared";
  /** Legacy alias for scope ("session" when true, "shared" when false). */
  perSession?: boolean;
  workspaceRoot?: string;
  /** Docker-specific sandbox settings. */
  docker?: SandboxDockerSettings;
  /** SSH-specific sandbox settings. */
  ssh?: SandboxSshSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
