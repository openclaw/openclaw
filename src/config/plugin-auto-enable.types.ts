import type { OpenClawConfig } from "./types.openclaw.js";

/** Reasons a configured surface can cause a plugin to be auto-enabled. */
export type PluginAutoEnableCandidate = { pluginId: string } & (
  | {
      kind: "channel-configured";
      channelId: string;
    }
  | {
      kind: "provider-auth-configured";
      providerId: string;
    }
  | {
      kind: "provider-model-configured";
      modelRef: string;
    }
  | {
      kind: "speech-provider-selected";
      providerId: string;
    }
  | {
      kind: "worker-provider-selected";
      providerId: string;
    }
  | {
      kind: "storage-provider-selected";
      providerId: string;
    }
  | {
      kind: "decision-provider-selected";
      providerId: string;
    }
  | {
      kind: "agent-harness-runtime-configured";
      runtime: string;
    }
  | {
      kind: "web-search-provider-selected";
      providerId: string;
    }
  | {
      kind: "web-fetch-provider-selected";
      providerId: string;
    }
  | {
      kind: "plugin-web-search-configured";
    }
  | {
      kind: "plugin-web-fetch-configured";
    }
  | {
      kind: "plugin-tool-configured";
    }
  | {
      kind: "configured-plugin-repaired";
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
