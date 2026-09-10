import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
// TTS core coordinates text preparation, provider selection, and speech output.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelRef,
} from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
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
  prepareSimpleCompletionModel: typeof import("../agents/simple-completion-runtime.js").prepareSimpleCompletionModel;
  requireApiKey: typeof import("../agents/model-auth.js").requireApiKey;
};

type DefaultSummarizeTextDeps = Omit<SummarizeTextDeps, "prepareSimpleCompletionModel"> & {
  acquireSimpleCompletionModel: typeof import("../agents/simple-completion-runtime.js").acquireSimpleCompletionModel;
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
    acquireSimpleCompletionModel: completionRuntime.acquireSimpleCompletionModel,
    requireApiKey,
  })));
}

type SummarizeResult = {
  summary: string;
  latencyMs: number;
  inputLength: number;
  outputLength: number;
};

type SummaryModelSelection = {
  ref: ModelRef;
  source: "summaryModel" | "default";
};

function resolveSummaryModelRef(
  cfg: OpenClawConfig,
  config: ResolvedTtsConfig,
): SummaryModelSelection {
  const defaultRef = resolveDefaultModelForAgent({ cfg });
  const override = normalizeOptionalString(config.summaryModel);
  if (!override) {
    return { ref: defaultRef, source: "default" };
  }

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: defaultRef.provider });
  const resolved = resolveModelRefFromString({
    raw: override,
    defaultProvider: defaultRef.provider,
    aliasIndex,
  });
  if (!resolved) {
    return { ref: defaultRef, source: "default" };
  }
  return { ref: resolved.ref, source: "summaryModel" };
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
    provider: string,
    completionDeps: Pick<
      SummarizeTextDeps,
      "completeWithPreparedSimpleCompletionModel" | "requireApiKey"
    >,
  ): Promise<SummarizeResult> => {
    if ("error" in prepared) {
      throw new Error(prepared.error);
    }
    const completionModel = prepared.model;
    const providerKey = completionDeps.requireApiKey(prepared.auth, provider);

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
    const { ref } = resolveSummaryModelRef(cfg, config);
    const prepared = await deps.prepareSimpleCompletionModel({
      cfg,
      provider: ref.provider,
      modelId: ref.model,
    });
    return await completeSummary(prepared, ref.provider, deps);
  }

  const resolvedDeps = await loadDefaultSummarizeTextDeps();
  const { ref } = resolveSummaryModelRef(cfg, config);
  const reported = createDeferredCore<SummarizeResult>();
  const parentSignal = getAsyncWorkSignal();
  void trackAsyncWork(async () => {
    const work = new AsyncWorkScope();
    const runInContext = work.run(() => AsyncLocalStorage.snapshot());
    const closeFromParent = () => runInContext(() => work.beginClose(parentSignal?.reason));
    parentSignal?.addEventListener("abort", closeFromParent, { once: true });
    if (parentSignal?.aborted) {
      closeFromParent();
    }
    let releaseModel: (() => void) | undefined;
    try {
      reported.resolve(
        await work.track(async () => {
          // Preparation precedes the request timer; the completion and its cleanup own the model.
          const prepared = await resolvedDeps.acquireSimpleCompletionModel({
            cfg,
            provider: ref.provider,
            modelId: ref.model,
          });
          if (!("error" in prepared)) {
            releaseModel = prepared.release;
          }
          return await completeSummary(prepared, ref.provider, resolvedDeps);
        }),
      );
    } catch (error) {
      reported.reject(error);
    } finally {
      await work.runWhenIdle(() => undefined);
      await runInContext(() => work.drain());
      parentSignal?.removeEventListener("abort", closeFromParent);
      releaseModel?.();
    }
  }).catch(reported.reject);
  return await reported.promise;
}
