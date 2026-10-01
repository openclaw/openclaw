import type { SessionEntry } from "../../config/sessions/types.js";
/** Resolves thinking and reasoning together when a command or model turn consumes them. */
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { normalizeThinkLevel, type ReasoningLevel, type ThinkLevel } from "../thinking.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import type { createModelSelectionState } from "./model-selection.js";
import { assertReplyPreprocessingActive } from "./reply-preprocessing-abort.js";

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
  abortSignal?: AbortSignal;
  modelState: Pick<
    Awaited<ReturnType<typeof createModelSelectionState>>,
    "resolveDefaultThinkingLevel" | "resolveDefaultReasoningLevel"
  >;
}): ReplyModelLevelResolver {
  const { selection, modelState, abortSignal } = params;
  const resolveLevels = createLazyPromise(
    async () => {
      assertReplyPreprocessingActive(abortSignal);
      const { provider, model, agentRuntime } = selection;
      const resolvedThinkLevel =
        selection.thinkLevel ??
        (await racePromiseWithAbortSignal(
          modelState.resolveDefaultThinkingLevel({ provider, model, agentRuntime }),
          abortSignal,
        ));
      // Shared catalog discovery may continue, but the canceled reply cannot use it.
      assertReplyPreprocessingActive(abortSignal);
      const resolvedReasoningLevel =
        !selection.reasoningExplicit &&
        selection.reasoningLevel === "off" &&
        resolvedThinkLevel === "off" &&
        !selection.thinkingExplicit
          ? await racePromiseWithAbortSignal(
              modelState.resolveDefaultReasoningLevel({ provider, model }),
              abortSignal,
            )
          : selection.reasoningLevel;
      return { resolvedThinkLevel, resolvedReasoningLevel };
    },
    { cacheRejections: true },
  );
  return async () => {
    assertReplyPreprocessingActive(abortSignal);
    const levels = await resolveLevels();
    assertReplyPreprocessingActive(abortSignal);
    return levels;
  };
}

/** Recompute model defaults for a primary probe while retaining explicit turn/session levels. */
export async function createReplyProbeModelLevelResolver(params: {
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  abortSignal?: AbortSignal;
  previous: ReplyModelLevelResolver;
  directives: Pick<InlineDirectives, "thinkLevel" | "clearThinkLevel" | "reasoningLevel">;
  sessionEntry: Pick<SessionEntry, "thinkingLevel" | "reasoningLevel">;
  thinkingLevelOverride?: string;
  configuredThinkingDefault?: ThinkLevel;
  hasConfiguredReasoningDefault: boolean;
}): Promise<ReplyModelLevelResolver> {
  assertReplyPreprocessingActive(params.abortSignal);
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
  assertReplyPreprocessingActive(params.abortSignal);
  return createReplyModelLevelResolver({
    modelState: params.modelState,
    abortSignal: params.abortSignal,
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
