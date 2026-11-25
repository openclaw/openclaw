import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { DecisionExecutionContext } from "./execution-types.js";
import type { DecisionReasoning } from "./input-types.js";

/** Private prepared facts supplied only to the selected executor; never projected in results. */
export type DecisionProviderContextV2 = DecisionExecutionContext & {
  readonly model: Omit<ModelCatalogEntry, "api"> & Partial<Pick<Model, "api" | "headers">>;
  readonly config: OpenClawConfig;
  readonly agentId?: string;
  readonly workspaceDir?: string;
  readonly auth: Readonly<Pick<ResolvedProviderAuth, "apiKey" | "mode" | "profileId">>;
  readonly reasoning?: DecisionReasoning;
};
