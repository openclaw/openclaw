export type AotuiPromptRole = "user" | "assistant";

export type AotuiAppRegistryEntryConfig = {
  /** Stable registry name used by agent-level app selections. */
  source: string;
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
  promptRole?: AotuiPromptRole;
};

export type AotuiAgentSelectionConfig = {
  /**
   * Registry entry names to install for this agent.
   * Omit to inherit defaults; set [] to install no AOTUI apps.
   */
  apps?: string[];
};

export type AotuiConfig = {
  /** Global registry of installable AOTUI app descriptors owned by OpenClaw config. */
  apps?: Record<string, AotuiAppRegistryEntryConfig>;
};
