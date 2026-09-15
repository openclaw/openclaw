/** Automatic intent bound to the complete request before creation resolves aliases. */
export type AgentRuntimeSpawnModelAutoSelection = {
  model: string;
  /** Self-origin distinguishes configured selection from legacy fallback residue. */
  hasFallbackOrigin: boolean;
};

export type AgentRuntimeSessionSpawnContext = {
  completionOwnerSessionKey?: string;
  inheritedToolPolicy: {
    version: 1;
    allow: string[];
    deny: string[];
  };
  spawnModelAutoSelection?: AgentRuntimeSpawnModelAutoSelection;
};
