/** Plugin-local native child instructions and restrictions; never an authority grant. */
export type PluginSubagentProfile = {
  id: string;
  description: string;
  /** Relative to the registering plugin package. */
  instructionsFile: string;
  outputSchema?: Record<string, unknown>;
  tools?: { deny: string[] };
};

/** Host snapshot retained by the registry generation that read the package bytes. */
export type RegisteredSubagentProfile = {
  pluginId: string;
  id: string;
  description: string;
  instructionsFile: string;
  instructionsSha256: string;
  instructions: string;
  outputSchema?: Record<string, unknown>;
  deny: string[];
};
