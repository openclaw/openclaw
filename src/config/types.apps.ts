export type AgentAppPromptRole = "user" | "assistant";

export type AgentAppRegistryEntryConfig = {
  /** Stable registry name used by agent-level app selections. */
  source: string;
  /** Original npm source spec when this entry was installed from npm. */
  npmSource?: string;
  /** Optional package/version constraint for npm-backed app sources. */
  version?: string;
  /** Enable or disable this registry entry. Default: true. */
  enabled?: boolean;
  /** Optional custom worker script override for this app. */
  workerScript?: string;
  /** Backward-compatible short description field. */
  description?: string;
  /** What the app is for, exposed to the runtime prompt surface. */
  whatItIs?: string;
  /** When the app should be used, exposed to the runtime prompt surface. */
  whenToUse?: string;
  /** Prompt projection role used by the runtime. */
  promptRole?: AgentAppPromptRole;
};

export type AgentAppsConfig = {
  /** Global kill switch for Agent Apps. Default: false. */
  enabled?: boolean;
  /** Global registry of installable Agent App descriptors owned by OpenClaw config. */
  registry?: Record<string, AgentAppRegistryEntryConfig>;
};
