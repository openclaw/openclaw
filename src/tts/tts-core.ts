import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
// TTS core coordinates text preparation, provider selection, and speech output.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { runWithAsyncWorkResources } from "../shared/async-work-resources.js";
import { sanitizeAssistantVisibleText } from "../shared/text/assistant-visible-text.js";
import type { ResolvedTtsConfig } from "./tts-types.js";
export {
  normalizeApplyTextNormalization,
  normalizeLanguageCode,
  normalizeSeed,
  requireInRange,
  resolveSpeechProviderApiKey,
  scheduleCleanup,
} from "./tts-provider-helpers.js";

type SummarizeTextDeps = {
  completeWithPreparedSimpleCompletionModel: typeof import("../agents/simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel;
  prepareSimpleCompletionModel: (
    params: import("../agents/simple-completion-runtime.js").PrepareSimpleCompletionModelParams,
  ) => ReturnType<
    typeof import("../agents/simple-completion-runtime.js").prepareSimpleCompletionModel
  >;
  requireApiKey: typeof import("../agents/model-auth.js").requireApiKey;
};

type DefaultSummarizeTextDeps = Omit<SummarizeTextDeps, "prepareSimpleCompletionModel"> & {
  acquireSimpleCompletionModelWithSelection: typeof import("../agents/simple-completion-runtime.js").acquireSimpleCompletionModelWithSelection;
};

let defaultSummarizeTextDepsPromise: Promise<DefaultSummarizeTextDeps> | undefined;

function loadDefaultSummarizeTextDeps(): Promise<DefaultSummarizeTextDeps> {
  // Speech provider imports should not initialize the LLM stack. Load it only
  // when synthesis actually needs summarization, then reuse the module bindings.
  return (defaultSummarizeTextDepsPromise ??= Promise.all([
    import("../agents/simple-completion-runtime.js"),
    import("../agents/model-auth.js"),
  ]).then(([completionRuntime, { requireApiKey }]) => ({
    completeWithPreparedSimpleCompletionModel:
      completionRuntime.completeWithPreparedSimpleCompletionModel,
    acquireSimpleCompletionModelWithSelection:
      completionRuntime.acquireSimpleCompletionModelWithSelection,
    requireApiKey,
  })));
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

function resolveSummaryModelSelection(
  cfg: OpenClawConfig,
  config: ResolvedTtsConfig,
  manifestPlugins?: PluginMetadataSnapshot,
) {
  const defaultRef = resolveDefaultModelForAgent({ cfg, manifestPlugins });
  const override = normalizeOptionalString(config.summaryModel);
  const resolved = override
    ? resolveModelRefFromString({
        cfg,
        raw: override,
        defaultProvider: defaultRef.provider,
        aliasIndex: buildModelAliasIndex({
          cfg,
          defaultProvider: defaultRef.provider,
          manifestPlugins,
        }),
        manifestPlugins,
      })
    : null;
  const raw = resolved ? override : resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  const model = raw ? splitTrailingAuthProfile(raw).model : undefined;
  const ref = resolved?.ref ?? defaultRef;
  return {
    selection: { provider: ref.provider, modelId: ref.model },
    ...(model && !model.includes("/") ? { shorthandModelId: model } : {}),
  };
}

/** Summarize long text before synthesis using the configured summary model. */
export async function summarizeText(
  params: {
    text: string;
    targetLength: number;
    cfg: OpenClawConfig;
    config: ResolvedTtsConfig;
    timeoutMs: number;
  },
  deps?: SummarizeTextDeps,
): Promise<SummarizeResult> {
  const { text, targetLength, cfg, config, timeoutMs } = params;
  if (targetLength < 100 || targetLength > 10_000) {
    throw new Error(`Invalid targetLength: ${targetLength}`);
  }

  const startTime = Date.now();
  const completeSummary = async (
    prepared: Awaited<ReturnType<SummarizeTextDeps["prepareSimpleCompletionModel"]>>,
    provider: string | undefined,
    completionDeps: Pick<
      SummarizeTextDeps,
      "completeWithPreparedSimpleCompletionModel" | "requireApiKey"
    >,
  ): Promise<SummarizeResult> => {
    if ("error" in prepared) {
      throw new Error(prepared.error);
    }
    const completionModel = prepared.model;
    const providerKey = completionDeps.requireApiKey(
      prepared.auth,
      provider ?? completionModel.provider,
    );

    try {
      const controller = new AbortController();
      const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
      const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);

      try {
        // Keep summarization on the simple-completion path so provider auth,
        // aliases, and timeout behavior match other lightweight model calls.
        const res = await completionDeps.completeWithPreparedSimpleCompletionModel({
          model: completionModel,
          auth: { ...prepared.auth, apiKey: providerKey },
          context: {
            messages: [
              {
                role: "user",
                content:
                  `You are an assistant that summarizes texts concisely while keeping the most important information. ` +
                  `Summarize the text to approximately ${targetLength} characters. Maintain the original tone and style. ` +
                  `Reply only with the summary, without additional explanations.\n\n` +
                  `<text_to_summarize>\n${text}\n</text_to_summarize>`,
                timestamp: Date.now(),
              },
            ],
          },
          cfg,
          options: {
            maxTokens: Math.ceil(targetLength / 2),
            temperature: 0.3,
            // Summary text is spoken; never recover incomplete reasoning as visible prose.
            strictReasoningTags: true,
            signal: controller.signal,
          },
        });
        const summary = sanitizeAssistantVisibleText(
          res.content
            .filter((block) => block.type === "text")
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join(" "),
        );

        if (!summary) {
          throw new Error("No summary returned");
        }

        return {
          summary,
          latencyMs: Date.now() - startTime,
          inputLength: text.length,
          outputLength: summary.length,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError") {
        throw new Error("Summarization timed out", { cause: err });
      }
      throw err;
    }
  };

  // The shipped dependency-injection argument keeps its caller-owned prepared model contract.
  if (deps) {
    const { selection } = resolveSummaryModelSelection(cfg, config);
    const prepared = await deps.prepareSimpleCompletionModel({
      cfg,
      provider: selection.provider,
      modelId: selection.modelId,
    });
    return await completeSummary(prepared, selection.provider, deps);
  }

  const resolvedDeps = await loadDefaultSummarizeTextDeps();
  return await runWithAsyncWorkResources(async (onAcquired) => {
    // Preparation precedes the request timer; the completion and its cleanup own the model.
    const prepared = await resolvedDeps.acquireSimpleCompletionModelWithSelection(
      { cfg },
      (manifestPlugins) => resolveSummaryModelSelection(cfg, config, manifestPlugins),
    );
    if (!("error" in prepared)) {
      onAcquired(prepared);
    }
    return await completeSummary(prepared, prepared.selection?.provider, resolvedDeps);
  });
}
