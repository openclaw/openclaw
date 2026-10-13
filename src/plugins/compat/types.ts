// Plugin compatibility types describe lifecycle status for plugin migration and deprecation checks.
type PluginCompatStatus = "active" | "deprecated" | "removal-pending" | "removed";

type PluginCompatOwner =
  | "agent-runtime"
  | "channel"
  | "config"
  | "core"
  | "plugin-execution"
  | "provider"
  | "sdk"
  | "setup";

export type PluginCompatRecord<Code extends string = string> = {
  code: Code;
  status: PluginCompatStatus;
  owner: PluginCompatOwner;
  introduced: string;
  deprecated?: string;
  warningStarts?: string;
  removeAfter?: string;
  // Requires a stable-shipped deprecation and compatibility period; never date-eligible by itself.
  removalGate?: "after-stable-deprecation";
  replacement?: string;
  docsPath: string;
  surfaces: readonly string[];
  diagnostics: readonly string[];
  tests: readonly string[];
  releaseNote?: string;
};
