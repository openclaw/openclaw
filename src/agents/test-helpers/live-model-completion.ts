import { writeSync } from "node:fs";
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { prepareModelForSimpleCompletion } from "@openclaw/ai/transports";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type Api, completeSimple, type Model } from "../../plugin-sdk/llm.js";
import {
  resolveLiveCompletionSessionId,
  resolveLiveSystemPrompt,
} from "../live-model-session-id.js";
import { createSingleUserPromptMessage } from "../live-test-config.js";
import { resolveLiveTestReasoning } from "../live-test-reasoning.js";

export function logProgress(message: string): void {
  writeSync(2, `[live] ${message}\n`);
}

export function formatElapsedSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1_000))}s`;
}

/** Keep completion calls and setup stages on the sweep's current config and heartbeat policy. */
export function createLiveModelCompletion(sweep: {
  getConfig: () => OpenClawConfig | undefined;
  heartbeatMs: number;
}) {
  async function withLiveHeartbeat<T>(operation: Promise<T>, context: string): Promise<T> {
    const startedAt = Date.now();
    let heartbeatCount = 0;
    const timer = setInterval(() => {
      heartbeatCount += 1;
      logProgress(`${context}: still running (${formatElapsedSeconds(Date.now() - startedAt)})`);
    }, sweep.heartbeatMs);
    timer.unref?.();
    try {
      return await operation;
    } finally {
      clearInterval(timer);
      if (heartbeatCount > 0) {
        logProgress(`${context}: completed after ${formatElapsedSeconds(Date.now() - startedAt)}`);
      }
    }
  }

  async function completeSimpleWithTimeout<TApi extends Api>(
    model: Model<TApi>,
    context: Parameters<typeof completeSimple<TApi>>[1],
    options: Parameters<typeof completeSimple<TApi>>[2],
    timeoutMs: number,
    progressContext: string,
  ) {
    const maxTimeoutMs = Math.max(1, timeoutMs);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort();
    }, maxTimeoutMs);
    abortTimer.unref?.();
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      hardTimer = setTimeout(() => {
        reject(new Error(`model call timed out after ${maxTimeoutMs}ms`));
      }, maxTimeoutMs);
      hardTimer.unref?.();
    });
    try {
      const completionModel = prepareModelForSimpleCompletion({
        apiRegistry: defaultApiRegistry,
        model,
        cfg: sweep.getConfig(),
      });
      const reasoning =
        options?.reasoning === undefined ? undefined : resolveLiveTestReasoning(completionModel);
      const result = await withLiveHeartbeat(
        Promise.race([
          completeSimple(completionModel, context, {
            ...options,
            sessionId: options?.sessionId ?? resolveLiveCompletionSessionId(model),
            reasoning,
            signal: controller.signal,
          }),
          timeout,
        ]),
        progressContext,
      );
      // Transports can resolve an aborted message before the same-deadline hard timer fires.
      if (result.stopReason === "aborted") {
        throw new Error(
          result.errorMessage ||
            (controller.signal.aborted
              ? `model call timed out after ${maxTimeoutMs}ms`
              : `${progressContext} was aborted`),
        );
      }
      return result;
    } finally {
      clearTimeout(abortTimer);
      if (hardTimer) {
        clearTimeout(hardTimer);
      }
    }
  }

  async function completeOkWithRetry(params: {
    model: Model;
    apiKey: string;
    timeoutMs: number;
    progressLabel: string;
  }) {
    const runOnce = async (maxTokens: number) => {
      const res = await completeSimpleWithTimeout(
        params.model,
        {
          systemPrompt: resolveLiveSystemPrompt(params.model),
          messages: createSingleUserPromptMessage("Reply with the word ok."),
        },
        {
          apiKey: params.apiKey,
          reasoning: resolveLiveTestReasoning(params.model),
          maxTokens,
        },
        params.timeoutMs,
        `${params.progressLabel}: prompt call (maxTokens=${maxTokens})`,
      );
      const text = res.content
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .join(" ");
      return { res, text };
    };

    const first = await runOnce(64);
    if (first.text.length > 0) {
      return first;
    }
    // Some providers (for example Moonshot Kimi and MiniMax M2.5) may emit
    // reasoning blocks first and only return text once token budget is higher.
    return await runOnce(256);
  }

  return { completeSimpleWithTimeout, completeOkWithRetry, withLiveHeartbeat };
}
