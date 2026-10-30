import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";

/** Private prepared facts supplied only to the selected executor; never projected in results. */
export type DecisionProviderContextV2 = {
  readonly model: Omit<ModelCatalogEntry, "api"> & Partial<Pick<Model, "api" | "headers">>;
  readonly config: OpenClawConfig;
  readonly agentId?: string;
  readonly workspaceDir?: string;
  readonly auth: Readonly<Pick<ResolvedProviderAuth, "apiKey" | "mode" | "profileId">>;
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
  readonly reasoning?: "auto" | "off" | "on";
  /** Check synchronously at physical dispatch, including after DNS or worker queue waits.
   * False closes this request; a thrown caller authority assertion remains terminal. */
  readonly isAdmissible: () => boolean;
};
