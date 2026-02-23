import type {
  SandboxBrowserSettings,
  SandboxBwrapSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.sandbox.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

export type AgentSandboxConfig = {
  mode?: "off" | "non-main" | "all";
  /**
   * Sandbox backend: "docker" (default) or "bwrap" (bubblewrap).
   * bwrap uses Linux namespaces without requiring Docker.
   */
  backend?: "docker" | "bwrap";
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
  /** Bubblewrap (bwrap) sandbox settings. */
  bwrap?: SandboxBwrapSettings;
  /** Optional sandboxed browser settings. */
  browser?: SandboxBrowserSettings;
  /** Auto-prune sandbox settings. */
  prune?: SandboxPruneSettings;
};
