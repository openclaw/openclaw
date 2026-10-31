export type PluginCompatRecord<Code extends string = string> = {
  code: Code;
  status: "active" | "deprecated" | "removal-pending" | "removed";
  owner:
    | "agent-runtime"
    | "channel"
    | "config"
    | "core"
    | "plugin-execution"
    | "provider"
    | "sdk"
    | "setup";
  // Untouched #164265 records still carry these retired inventory fields.
  introduced?: string;
  deprecated?: string;
  warningStarts?: string;
  removeAfter?: string;
  removalGate?: "stable-deprecation-period";
  replacement?: string;
  docsPath: string;
  surfaces: readonly string[];
  diagnostics: readonly string[];
  tests?: readonly string[];
  releaseNote?: string;
};
