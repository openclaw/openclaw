import type { ResolvedProviderAuth } from "../agents/model-auth-runtime-shared.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import type { DecisionEvaluateOptionsV2 } from "./types-v2.js";

/** Shared prepared provider facts supplied to a first-class decision executor. */
export type DecisionProviderContextV2 = {
  /** Canonical metadata with the actual runtime API and private effective request headers. */
  readonly model: Omit<ModelCatalogEntry, "api"> & Partial<Pick<Model, "api" | "headers">>;
  readonly config: OpenClawConfig;
  readonly agentId?: string;
  readonly workspaceDir?: string;
  /** Resolved by the common auth owner; an executor must not select another credential. */
  readonly auth: Readonly<Pick<ResolvedProviderAuth, "apiKey" | "mode" | "profileId">>;
  readonly signal: AbortSignal;
  readonly deadlineMonotonicMs: number;
  readonly reasoning?: DecisionEvaluateOptionsV2["reasoning"];
};
