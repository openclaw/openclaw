import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "./test-helpers.js";

describe("Talk catalog-selected ClawRouter speech", () => {
  it.each([
    "openai",
    "gradium",
    "azure-speech",
    "elevenlabs-native",
    "elevenlabs-manifest",
  ] as const)("Talk via %s refreshes grants", async (selection) => {
    const eleven = selection.startsWith("elevenlabs-");
    const upstream = eleven ? "elevenlabs" : selection;
    const nativeEleven = selection === "elevenlabs-native";
    const gradium = upstream === "gradium";
    const azure = upstream === "azure-speech";
    const modelLess = gradium || azure || eleven;
    const route = nativeEleven
      ? "/v1/native/elevenlabs/v1/text-to-speech/${voice_id}"
      : azure
        ? "/v1/native/azure-speech/cognitiveservices/v1"
        : `/v1/proxy/${upstream}/speech`;
    await withTempHome(
      async () => {
        const audio = eleven
          ? Buffer.from(
              "//uQxAADwAABpAAAACAAADSAAAAETEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//uSxDkDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7ksQ5A8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=",
              "base64",
            )
          : gradium
            ? Buffer.from(
                "UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "base64",
              )
            : Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
        const calls: Array<{ url: string; auth?: string; body?: unknown }> = [];
        let eligible = true;
        await withServer(
          (req, res) => {
            void (async () => {
              const url = req.url ?? "";
              if (url === "/v1/catalog") {
                calls.push({ url, auth: req.headers.authorization });
                res.setHeader("content-type", "application/json");
                res.end(
                  JSON.stringify({
                    version: "clawrouter.client-catalog.v1",
                    observedAt: new Date().toISOString(),
                    scope: {
                      authType: "proxy_key",
                      credentialId: "synthetic-router-id",
                      principalId: null,
                    },
                    providers: [
                      {
                        id: upstream,
                        allowed: true,
                        executable: true,
                        nativeBaseUrl: `/v1/native/${upstream}`,
                        routes: [
                          {
                            endpoint: "speech",
                            path: eleven
                              ? "/v1/text-to-speech/${voice_id}"
                              : azure
                                ? "/cognitiveservices/v1"
                                : gradium
                                  ? "/api/post/speech/tts"
                                  : "/v1/audio/speech",
                            methods: ["POST"],
                            requestFormat: eleven
                              ? "elevenlabs.speech"
                              : azure
                                ? "azure_speech.ssml"
                                : gradium
                                  ? "gradium.speech"
                                  : "openai.audio_speech",
                            responseFormat: "audio.binary",
                          },
                        ],
                        models: modelLess
                          ? []
                          : [
                              {
                                id: "openai/tts-1",
                                upstream: "tts-1",
                                capabilities: ["audio.speech"],
                              },
                            ],
                        offers: [
                          {
                            endpoint: "speech",
                            modelId: modelLess ? null : "openai/tts-1",
                            transport: "http",
                            routeKind: azure || nativeEleven ? "native" : "manifest",
                            route,
                            eligible,
                            affordability: "request-dependent",
                          },
                        ],
                      },
                    ],
                  }),
                );
                return;
              }
              let body = "";
              for await (const chunk of req) {
                body += chunk;
              }
              expect(req.headers["x-api-key"]).toBeUndefined();
              expect(req.headers["xi-api-key"]).toBeUndefined();
              if (azure) {
                expect(req.headers["content-type"]).toBe("application/ssml+xml");
                expect(req.headers["x-microsoft-outputformat"]).toBe(
                  "audio-24khz-48kbitrate-mono-mp3",
                );
                expect(req.headers["ocp-apim-subscription-key"]).toBeUndefined();
              }
              calls.push({
                url,
                auth: req.headers.authorization,
                body: azure ? body : JSON.parse(body),
              });
              res.setHeader("content-type", gradium ? "audio/wav" : "audio/mpeg");
              res.end(audio);
            })().catch((error: unknown) =>
              res.destroy(error instanceof Error ? error : new Error(String(error))),
            );
          },
          async (baseUrl) => {
            const cfg: OpenClawConfig = {
              plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
              models: {
                providers: {
                  clawrouter: {
                    baseUrl,
                    apiKey: "synthetic-router-key",
                    models: [],
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
              talk: {
                provider: "clawrouter",
                providers: {
                  clawrouter: {
                    ...(eleven
                      ? {
                          upstreamProvider: "elevenlabs",
                          speakerVoiceId: "syntheticVoice1234567",
                          voiceAliases: { narrator: "syntheticOverride123" },
                          latencyTier: 2,
                        }
                      : azure
                        ? {
                            upstreamProvider: "azure-speech",
                            speakerVoiceId: "en-US-JennyNeural",
                            lang: "en-US",
                          }
                        : gradium
                          ? { upstreamProvider: "gradium", speakerVoiceId: "synthetic-voice" }
                          : {
                              modelId: "openai/tts-1",
                              speakerVoiceId: "shimmer",
                              responseFormat: "mp3",
                            }),
                  },
                },
              },
            };
            setRuntimeConfigSnapshot(cfg, cfg);
            try {
              const result = await invokeTalkSpeakDirect({
                text: "Synthetic Talk speech",
                voiceId: eleven
                  ? "syntheticOverride123"
                  : azure
                    ? "en-US-AriaNeural"
                    : gradium
                      ? "synthetic-override"
                      : "nova",
                ...(modelLess ? {} : { speed: 1.25 }),
              });
              expect(result, JSON.stringify(result?.error)).toMatchObject({
                ok: true,
                payload: {
                  provider: "clawrouter",
                  audioBase64: audio.toString("base64"),
                  outputFormat: eleven
                    ? "mp3_44100_128"
                    : azure
                      ? "audio-24khz-48kbitrate-mono-mp3"
                      : gradium
                        ? "wav"
                        : "mp3",
                  mimeType: gradium ? "audio/wav" : "audio/mpeg",
                },
              });
              const elevenBody = {
                text: "Synthetic Talk speech",
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                  stability: 0.5,
                  similarity_boost: 0.75,
                  style: 0,
                  use_speaker_boost: true,
                  speed: 1,
                },
              };
              const postedRoute = nativeEleven
                ? "/v1/native/elevenlabs/v1/text-to-speech/syntheticOverride123?output_format=mp3_44100_128&optimize_streaming_latency=2"
                : route;
              expect(calls).toEqual([
                { url: "/v1/catalog", auth: "Bearer synthetic-router-key" },
                {
                  url: postedRoute,
                  auth: "Bearer synthetic-router-key",
                  body: eleven
                    ? nativeEleven
                      ? elevenBody
                      : {
                          body: elevenBody,
                          pathParams: { voice_id: "syntheticOverride123" },
                          query: {
                            output_format: "mp3_44100_128",
                            optimize_streaming_latency: "2",
                          },
                        }
                    : azure
                      ? '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-AriaNeural">Synthetic Talk speech</voice></speak>'
                      : {
                          body: gradium
                            ? {
                                text: "Synthetic Talk speech",
                                voice_id: "synthetic-override",
                                only_audio: true,
                                output_format: "wav",
                                json_config: '{"padding_bonus":0}',
                              }
                            : {
                                model: "tts-1",
                                input: "Synthetic Talk speech",
                                voice: "nova",
                                response_format: "mp3",
                                speed: 1.25,
                              },
                        },
                },
              ]);
              if (eleven) {
                const aliased = await invokeTalkSpeakDirect({
                  text: "Synthetic Talk speech",
                  voiceId: "Narrator",
                });
                expect(aliased).toMatchObject({ ok: true });
                expect(calls.slice(2)).toEqual(calls.slice(0, 2));
              }
              eligible = false;
              const denied = await invokeTalkSpeakDirect({ text: "Do not synthesize" });
              expect(denied).toMatchObject({
                ok: false,
                error: { message: expect.stringContaining("no eligible supported offer") },
              });
              expect(calls.map((call) => call.url)).toEqual([
                "/v1/catalog",
                postedRoute,
                ...(eleven ? ["/v1/catalog", postedRoute] : []),
                "/v1/catalog",
              ]);
            } finally {
              clearRuntimeConfigSnapshot();
            }
          },
        );
      },
      {
        env: {
          CLAWROUTER_API_KEY: undefined,
          OPENAI_API_KEY: "synthetic-upstream-not-router",
          GRADIUM_API_KEY: "synthetic-gradium-not-router",
          ELEVENLABS_API_KEY: "synthetic-elevenlabs-not-router",
          AZURE_SPEECH_API_KEY: "synthetic-azure-not-router",
          AZURE_SPEECH_REGION: "westus",
        },
      },
    );
  });
});
