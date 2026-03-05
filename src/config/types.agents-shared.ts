import type {
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";

/**
 * Per-chat-type model overrides.
 * Allows specifying different models for direct messages vs group chats.
 */
export type AgentModelByChatType = {
  /** Model to use for direct/DM conversations. */
  direct?: string;
  /** Model to use for group chats. */
  group?: string;
  /** Model to use for channel conversations. */
  channel?: string;
};

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
      /** Per-chat-type model overrides (direct/group/channel). */
      byChatType?: AgentModelByChatType;
    };

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
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
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
