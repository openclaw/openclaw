/** Resolves thinking and reasoning together when a command or model turn consumes them. */
import { createLazyPromise } from "../../shared/lazy-promise.js";
import type { ReasoningLevel, ThinkLevel } from "../thinking.js";
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
