import type { SessionEntry } from "../../config/sessions/types.js";
/** Resolves thinking and reasoning together when a command or model turn consumes them. */
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { normalizeThinkLevel, type ReasoningLevel, type ThinkLevel } from "../thinking.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { createModelSelectionState } from "./model-selection.js";

type ReplyModelLevelSelection = {
  provider: string;
  model: string;
  agentRuntime?: string | null;
  thinkLevel?: ThinkLevel;
  thinkingExplicit: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningExplicit: boolean;
};

type ReplyModelLevels = {
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
};

export type ReplyModelLevelResolver = () => Promise<ReplyModelLevels>;

export function createReplyModelLevelResolver(params: {
  selection: ReplyModelLevelSelection;
  modelState: Pick<
    Awaited<ReturnType<typeof createModelSelectionState>>,
    "resolveDefaultThinkingLevel" | "resolveDefaultReasoningLevel"
  >;
}): ReplyModelLevelResolver {
  const { selection, modelState } = params;
  return createLazyPromise(
    async () => {
      const { provider, model, agentRuntime } = selection;
      const resolvedThinkLevel =
        selection.thinkLevel ??
        (await modelState.resolveDefaultThinkingLevel({ provider, model, agentRuntime }));
      const resolvedReasoningLevel =
        !selection.reasoningExplicit &&
        selection.reasoningLevel === "off" &&
        resolvedThinkLevel === "off" &&
        !selection.thinkingExplicit
          ? await modelState.resolveDefaultReasoningLevel({ provider, model })
          : selection.reasoningLevel;
      return { resolvedThinkLevel, resolvedReasoningLevel };
    },
    { cacheRejections: true },
  );
}

/** Recompute model defaults for a primary probe while retaining explicit turn/session levels. */
export async function createReplyProbeModelLevelResolver(params: {
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  previous: ReplyModelLevelResolver;
  directives: Pick<InlineDirectives, "thinkLevel" | "clearThinkLevel" | "reasoningLevel">;
  sessionEntry: Pick<SessionEntry, "thinkingLevel" | "reasoningLevel">;
  thinkingLevelOverride?: string;
  configuredThinkingDefault?: ThinkLevel;
  hasConfiguredReasoningDefault: boolean;
}): Promise<ReplyModelLevelResolver> {
  const hasTurnOrSessionThinkLevel =
    normalizeThinkLevel(params.thinkingLevelOverride) !== undefined ||
    params.directives.thinkLevel !== undefined ||
    (!params.directives.clearThinkLevel && params.sessionEntry.thinkingLevel !== undefined);
  const hasExplicitThinkLevel =
    hasTurnOrSessionThinkLevel ||
    params.configuredThinkingDefault !== undefined ||
    params.modelState.hasConfiguredThinkingDefault === true;
  const hasExplicitReasoningLevel =
    params.directives.reasoningLevel !== undefined ||
    params.sessionEntry.reasoningLevel != null ||
    params.hasConfiguredReasoningDefault;
  const previous =
    hasTurnOrSessionThinkLevel || hasExplicitReasoningLevel ? await params.previous() : undefined;
  return createReplyModelLevelResolver({
    modelState: params.modelState,
    selection: {
      provider: params.modelState.provider,
      model: params.modelState.model,
      thinkLevel: hasTurnOrSessionThinkLevel ? previous?.resolvedThinkLevel : undefined,
      thinkingExplicit: hasExplicitThinkLevel,
      reasoningLevel: hasExplicitReasoningLevel ? previous!.resolvedReasoningLevel : "off",
      reasoningExplicit: hasExplicitReasoningLevel,
    },
  });
}
