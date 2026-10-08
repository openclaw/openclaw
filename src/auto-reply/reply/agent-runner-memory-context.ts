import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveContextTokenBudgetForModel } from "../../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { findModelInCatalog } from "../../agents/model-catalog-lookup.js";
import { resolveModelContextWindowProfile } from "../../agents/model-context-window.js";
import { resolveContextConfigProviderForRuntime } from "../../agents/openai-routing.js";
import {
  resolveProjectedSessionContextTokenBudget,
  resolveProjectedSessionContextTokens,
} from "../../config/sessions/context-token-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FollowupRun } from "./queue.js";

export async function resolveFollowupContextTokens(
  {
    cfg,
    followupRun,
    defaultModel,
    sessionEntry,
  }: {
    cfg: OpenClawConfig;
    followupRun: FollowupRun;
    defaultModel: string;
    sessionEntry?: SessionEntry;
  },
  runtimeId: string,
): Promise<number> {
  const { provider } = followupRun.run;
  const model = followupRun.run.model ?? defaultModel;
  const catalogModel = findModelInCatalog(
    (followupRun.run.thinkingCatalog ?? []).filter((entry) =>
      runtimeId === "openclaw" ? !entry.nativeRuntime : entry.nativeRuntime === runtimeId,
    ),
    provider,
    model,
  );
  const contextWindowProfile = resolveModelContextWindowProfile({
    catalogEntry: catalogModel,
    selected: sessionEntry?.contextWindow,
  });
  const selectedContextTokens = contextWindowProfile.contextWindow
    ? asPositiveFiniteNumber(contextWindowProfile.contextTokens)
    : undefined;
  const contextParams = {
    contextWindow: sessionEntry?.contextWindow,
    profileId: followupRun.run.authProfileId,

    nativeRuntime: runtimeId,
    cfg,
    agentId: followupRun.run.agentId,
    agentDir: followupRun.run.agentDir,
    workspaceDir: followupRun.run.workspaceDir,
    provider: resolveContextConfigProviderForRuntime({ provider, runtimeId, config: cfg }),
    model,
    modelContextWindow: contextWindowProfile.contextTokens,
    modelContextTokens: catalogModel?.contextTokens,
    modelContextWindowSource: contextWindowProfile.contextWindow
      ? undefined
      : catalogModel?.contextWindowSource,
    allowAsyncLoad: false,
  };
  const selection = {
    provider,
    model,
    agentHarnessId: runtimeId,
    authProfileId: followupRun.run.authProfileId,
  };
  const knownContextBudget = resolveProjectedSessionContextTokenBudget({
    entry: sessionEntry,
    ...selection,
    resolvedContextTokens: undefined,
  });
  const projection = await resolveContextTokenBudgetForModel({
    ...contextParams,
    knownContextBudget,
  });
  const projected = resolveProjectedSessionContextTokens({
    entry: sessionEntry,
    ...selection,
    resolvedContextTokens: projection.source === "fallback" ? undefined : projection.contextTokens,
    resolvedContextTokensSource: projection.contextTokensSource,
    authoredContextTokens: projection.authoredContextTokens,
  });
  const budget =
    projected !== undefined && selectedContextTokens !== undefined
      ? Math.min(projected, selectedContextTokens)
      : projected;
  return budget ?? projection.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
}
