/** Read-only model choices admitted for the current requester and session incarnation. */
export type PluginRequesterModelCatalog = {
  /** Opaque content revision; changes when the public projection changes. */
  revision: string;
  /** Pending inventory is incomplete and must never be treated as proof of availability. */
  state: "prepared" | "pending";
  models: {
    id: string;
    provider: string;
    name: string;
    thinkingLevels?: string[];
    fastModes?: (boolean | "auto")[];
  }[];
  selectionPolicy?: { restricted: true; defaultModel: string | null };
};

/** No selectors, refresh, credential access, or authority to execute a model. */
export type PluginRequesterModels = {
  list: () => Promise<PluginRequesterModelCatalog>;
};
