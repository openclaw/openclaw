import type { OpenClawConfig } from "../config/types.js";
import type { TtsDirectiveOverrides } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import type { TtsTelephonyResult } from "./tts-runtime-types.js";
import { executeTtsProviderAttempts, withOwnedTtsRequest } from "./tts-synthesis-support.js";

export async function textToSpeechTelephony(params: {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  overrides?: TtsDirectiveOverrides;
  timeoutMs?: number;
}): Promise<TtsTelephonyResult> {
  assertSpeechRuntimeAvailable();
  return await withOwnedTtsRequest(
    {
      text: params.text,
      cfg: params.cfg,
      prefsPath: params.prefsPath,
      providerOverride: params.overrides?.provider,
    },
    async (setup) => {
      if ("error" in setup) {
        return { success: false, error: setup.error };
      }

      const { cfg, config, persona, providers } = setup;
      return await executeTtsProviderAttempts({
        cfg,
        config,
        persona,
        providers,
        synthesisText: params.text,
        providerOverrides: params.overrides?.providerOverrides,
        timeoutMs: params.timeoutMs,
        target: "telephony",
        logLabel: "TTS telephony",
        requireTelephony: true,
        prepareProviderRegistry: setup.prepareProviderRegistry,
        selectOperation: ({ resolvedProvider }) => {
          const synthesizeTelephony = resolvedProvider.provider.synthesizeTelephony as NonNullable<
            typeof resolvedProvider.provider.synthesizeTelephony
          >;
          return {
            kind: "ready",
            synthesize: ({ prepared, cfg: runtimeCfg, timeoutMs }) =>
              synthesizeTelephony({
                text: prepared.text,
                cfg: runtimeCfg,
                providerConfig: prepared.providerConfig,
                providerOverrides: prepared.providerOverrides,
                timeoutMs,
              }),
          };
        },
        buildSuccess: ({ synthesis, ...metadata }) => ({
          success: true,
          ...metadata,
          audioBuffer: synthesis.audioBuffer,
          outputFormat: synthesis.outputFormat,
          sampleRate: synthesis.sampleRate,
        }),
      });
    },
  );
}
