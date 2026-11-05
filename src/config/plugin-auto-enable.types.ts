import type { OpenClawConfig } from "./types.openclaw.js";

/** Reasons a configured surface can cause a plugin to be auto-enabled. */
export type PluginAutoEnableCandidate = { pluginId: string } & (
  | {
      kind: "channel-configured";
      channelId: string;
    }
  | {
      kind:
        | "provider-auth-configured"
        | "speech-provider-selected"
        | "worker-provider-selected"
        | "storage-provider-selected"
        | "decision-provider-selected"
        | "web-search-provider-selected"
        | "web-fetch-provider-selected";
      providerId: string;
    }
  | {
      kind: "provider-model-configured";
      modelRef: string;
    }
  | {
      kind: "agent-harness-runtime-configured";
      runtime: string;
    }
  | {
      kind:
        | "plugin-web-search-configured"
        | "plugin-web-fetch-configured"
        | "plugin-tool-configured"
        | "configured-plugin-repaired";
    }
  | {
      kind: "setup-auto-enable";
      reason: string;
    }
);

export type PluginAutoEnableResult = {
  config: OpenClawConfig;
  changes: string[];
  autoEnabledReasons: Record<string, string[]>;
};
