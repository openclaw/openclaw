/**
 * Safety Posture Presets for OpenClaw
 *
 * These presets control default security configurations for new installations.
 * Issue #7827: Default Safety Posture - Sandbox & Session Isolation
 */

/**
 * Safety posture preset identifiers.
 *
 * - "development": Permissive defaults for local development (sandbox off, full tool access)
 * - "balanced": Moderate security with sandbox for non-main sessions (recommended default)
 * - "strict": Maximum security isolation for public-facing deployments
 */
export type SafetyPosturePreset = "development" | "balanced" | "strict";

/**
 * Agent profile identifiers for tool access control.
 *
 * - "full": All tools available (development mode)
 * - "limited": High-risk tools blocked (exec, browser, web_fetch on host)
 * - "public": Minimal tool access for untrusted contexts
 */
export type AgentToolProfile = "full" | "limited" | "public";

/**
 * Sandbox mode presets for agent configurations.
 */
export type SandboxModePreset = "off" | "non-main" | "all";

/**
 * Workspace access presets for sandboxed sessions.
 */
export type SandboxWorkspaceAccessPreset = "none" | "ro" | "rw";

/**
 * Configuration for safety posture presets.
 */
export type SafetyPostureConfig = {
  /**
   * Active safety posture preset.
   * Default: "development" for backward compatibility with existing installs.
   * New installs should use "balanced" for better security.
   */
  preset?: SafetyPosturePreset;

  /**
   * Agent tool access profile override.
   * When set, overrides the default profile derived from the preset.
   */
  agentProfile?: AgentToolProfile;

  /**
   * Enable secure DM mode (per-channel-peer session isolation).
   * When true, sets session.dmScope to "per-channel-peer" for better
   * isolation between different users in DMs.
   */
  secureDmMode?: boolean;
};

/**
 * Default values for safety posture configuration.
 */
export const SAFETY_POSTURE_DEFAULTS = {
  /** Default preset for new installations */
  defaultPreset: "development" as SafetyPosturePreset,

  /** Recommended preset for production deployments */
  recommendedPreset: "balanced" as SafetyPosturePreset,

  /** Default DM scope for secure mode */
  secureDmScope: "per-channel-peer" as const,
} as const;

/**
 * High-risk tools that are denied in "public" agent profile.
 * These tools can access external systems or execute arbitrary code.
 */
export const PUBLIC_PROFILE_DENIED_TOOLS = [
  "exec",
  "browser",
  "web_fetch",
  "web_search",
  "gateway",
  "nodes",
  "cron",
  "canvas",
  "subagents",
  "sessions_spawn",
  "sessions_send",
] as const;

/**
 * Tools denied in "limited" agent profile.
 * These can escape the sandbox or access host resources.
 */
export const LIMITED_PROFILE_HOST_DENIED_TOOLS = [
  "exec",
  "browser",
  "web_fetch",
  "gateway",
  "nodes",
  "cron",
] as const;

/**
 * Sandbox configuration presets by safety posture.
 */
export const SANDBOX_PRESETS = {
  development: {
    mode: "off" as const,
    workspaceAccess: "rw" as const,
    docker: {
      network: "bridge" as const,
    },
  },
  balanced: {
    mode: "non-main" as const,
    workspaceAccess: "ro" as const,
    docker: {
      network: "none" as const,
    },
  },
  strict: {
    mode: "all" as const,
    workspaceAccess: "none" as const,
    docker: {
      network: "none" as const,
    },
  },
} as const;

/**
 * Session configuration presets by safety posture.
 */
export const SESSION_PRESETS = {
  development: {
    dmScope: "main" as const,
  },
  balanced: {
    dmScope: "per-channel-peer" as const,
  },
  strict: {
    dmScope: "per-channel-peer" as const,
  },
} as const;

/**
 * Memory configuration presets by safety posture.
 */
export const MEMORY_PRESETS = {
  development: {
    longTermMemoryEnabled: true,
  },
  balanced: {
    longTermMemoryEnabled: true,
  },
  strict: {
    longTermMemoryEnabled: false, // Disable for public agents
  },
} as const;
