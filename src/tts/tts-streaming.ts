import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.js";
import { finishCapabilityOperation } from "../plugins/capability-provider-acquisition.js";
import type { TtsDirectiveOverrides } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { normalizeSpeechText } from "./speech-text.js";
import type { TtsStreamResult, TtsSynthesisStreamResult } from "./tts-runtime-types.js";
import { captureSpeechProviderStream, ownSpeechStream } from "./tts-streaming-resources.js";
import { executeTtsProviderAttempts, acquireTtsRequest } from "./tts-synthesis-support.js";
import { resolveTtsSynthesisTarget } from "./tts-synthesis.js";

export async function streamSpeech(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsSynthesisStreamResult> {
  assertSpeechRuntimeAvailable();
  const acquired = await acquireTtsRequest({
    text: params.text,
    cfg: params.cfg,
    prefsPath: params.prefsPath,
    providerOverride: params.overrides?.provider,
    disableFallback: params.disableFallback,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if ("error" in acquired) {
    return { success: false, error: acquired.error };
  }

  const { cfg, config, persona, providers } = acquired.setup;
  let outcome: Result<TtsSynthesisStreamResult, unknown>;
  try {
    const result = await acquired.run(() => {
      const target = resolveTtsSynthesisTarget(params.channel);
      return executeTtsProviderAttempts({
        cfg,
        config,
        persona,
        providers,
        synthesisText: normalizeSpeechText(params.text),
        providerOverrides: params.overrides?.providerOverrides,
        timeoutMs: params.timeoutMs,
        target,
        logLabel: "TTS stream",
        prepareProviderRegistry: acquired.setup.prepareProviderRegistry,
        selectOperation: ({ provider, resolvedProvider }) => {
          if (!resolvedProvider.provider.streamSynthesize) {
            return {
              kind: "skip",
              reasonCode: "unsupported_for_streaming",
              message: `${provider} does not support streaming TTS`,
            };
          }
          return {
            kind: "ready",
            synthesize: async ({
              prepared,
              cfg: runtimeCfg,
              target: synthesisTarget,
              timeoutMs,
            }) => {
              const synthesis = await resolvedProvider.provider.streamSynthesize!({
                text: prepared.text,
                cfg: runtimeCfg,
                providerConfig: prepared.providerConfig,
                target: synthesisTarget,
                providerOverrides: prepared.providerOverrides,
                timeoutMs,
              });
              return {
                providerResult: synthesis,
                transport: await captureSpeechProviderStream(synthesis, acquired),
              };
            },
            cleanupFailedProjection: async ({ transport }) => {
              await transport.close();
            },
          };
        },
        buildSuccess: ({ synthesis: { providerResult, transport }, ...metadata }) => ({
          success: true as const,
          ...metadata,
          transport,
          outputFormat: providerResult.outputFormat,
          voiceCompatible: providerResult.voiceCompatible,
          fileExtension: providerResult.fileExtension,
          target,
        }),
      });
    });
    if (result.success) {
      const { transport, ...metadata } = result;
      return { ...metadata, ...ownSpeechStream(transport, acquired) };
    }
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, error };
  }
  return await finishCapabilityOperation(outcome, acquired.release);
}

export async function textToSpeechStream(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
}): Promise<TtsStreamResult> {
  const synthesis = await streamSpeech(params);
  if (!synthesis.success || !synthesis.audioStream || !synthesis.fileExtension) {
    await synthesis.release?.();
    return {
      success: false,
      error: synthesis.error ?? "Streaming TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }
  return synthesis;
}
