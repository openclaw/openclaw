import type { ModelAllowList } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";

export type ModelsCommandSessionEntry = Partial<
  Pick<
    SessionEntry,
    | "authProfileOverride"
    | "authProfileOverrideSource"
    | "modelProvider"
    | "providerOverride"
    | "model"
    | "modelOverride"
    | "modelSelectionLocked"
    | "agentRuntimeOverride"
  >
>;

export type ModelsProviderData = {
  allowList?: ModelAllowList;
  byProvider: Map<string, Set<string>>;
  pendingProviders?: readonly string[];
  providers: string[];
  resolvedDefault: { provider: string; model: string };
  /** Captured policy result; absent only in results from older SDK producers. */
  effectiveDefault?: ModelsProviderData["resolvedDefault"] | null;
  modelNames: Map<string, string>;
  modelMenu?: {
    modelNames: ReadonlyMap<string, string>;
    byProvider: ReadonlyMap<string, ModelsProviderMenu>;
  };
  refreshWarning?: string;
  runtimeChoicesByProvider?: Map<string, ModelsRuntimeChoice[]>;
  runtimeChoicesByModel?: Map<string, ModelsRuntimeChoice[]>;
  isCurrent?: () => boolean;
};

export type ModelsProviderMenu = { available: number; notice: string };
export type PreparedModelsProviderData = ModelsProviderData & {
  modelCatalog: ModelCatalogEntry[];
};

export type ModelsBrowseOptions = {
  sessionKey?: string;
  view?: "default" | "all";
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
};

export type ModelsRuntimeChoice = {
  id: string;
  label: string;
  description: string;
};
