import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ChatMetadataResult, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";

export type ChatStartupProjectionReadParams = {
  agentId: string;
  sessionKey?: string;
  sessionEntry?: ChatMetadataSessionEntry;
  // Ready reads return settled catalogs only; startup also prepares commands and worker policy.
  readPolicy?: "current" | "ready";
};

export type ChatStartupProjectionResult = {
  commandsRevision?: string;
  metadata?: Pick<
    ChatMetadataResult,
    "commands" | "swarmEnabled" | "requiredWorkerInferenceProfileId"
  >;
  sessionModelCatalog?: ModelCatalogEntry[];
  defaultModelCatalog?: ModelCatalogEntry[];
};
