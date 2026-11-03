import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { invokeTalkSpeakDirect } from "./test-helpers.js";

describe("Talk catalog-selected ClawRouter speech", () => {
  it("runs talk.speak through the registered provider and rejects a revoked offer", async () => {
    await withTempHome(
      async () => {
        const audio = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
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
                    providers: [
                      {
                        id: "openai",
                        allowed: true,
                        executable: true,
                        nativeBaseUrl: "/v1/native/openai",
                        routes: [
                          {
                            endpoint: "speech",
                            path: "/v1/audio/speech",
                            methods: ["POST"],
                            requestFormat: "openai.audio_speech",
                            responseFormat: "audio.binary",
                          },
                        ],
                        models: [
                          { id: "openai/tts-1", upstream: "tts-1", capabilities: ["audio.speech"] },
                        ],
                        offers: [
                          {
                            endpoint: "speech",
                            modelId: "openai/tts-1",
                            transport: "http",
                            routeKind: "manifest",
                            route: "/v1/proxy/openai/speech",
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
              calls.push({ url, auth: req.headers.authorization, body: JSON.parse(body) });
              res.setHeader("content-type", "audio/mpeg");
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
                    modelId: "openai/tts-1",
                    speakerVoiceId: "shimmer",
                    responseFormat: "mp3",
                  },
                },
              },
            };
            setRuntimeConfigSnapshot(cfg, cfg);
            try {
              const result = await invokeTalkSpeakDirect({
                text: "Synthetic Talk speech",
                voiceId: "nova",
                speed: 1.25,
              });
              expect(result, JSON.stringify(result?.error)).toMatchObject({
                ok: true,
                payload: {
                  provider: "clawrouter",
                  audioBase64: audio.toString("base64"),
                  outputFormat: "mp3",
                  mimeType: "audio/mpeg",
                },
              });
              expect(calls).toEqual([
                { url: "/v1/catalog", auth: "Bearer synthetic-router-key" },
                {
                  url: "/v1/proxy/openai/speech",
                  auth: "Bearer synthetic-router-key",
                  body: {
                    body: {
                      model: "tts-1",
                      input: "Synthetic Talk speech",
                      voice: "nova",
                      response_format: "mp3",
                      speed: 1.25,
                    },
                  },
                },
              ]);
              eligible = false;
              const denied = await invokeTalkSpeakDirect({ text: "Do not synthesize" });
              expect(denied).toMatchObject({
                ok: false,
                error: { message: expect.stringContaining("no eligible supported offer") },
              });
              expect(calls.map((call) => call.url)).toEqual([
                "/v1/catalog",
                "/v1/proxy/openai/speech",
                "/v1/catalog",
              ]);
            } finally {
              clearRuntimeConfigSnapshot();
            }
          },
        );
      },
      { env: { CLAWROUTER_API_KEY: undefined, OPENAI_API_KEY: "synthetic-upstream-not-router" } },
    );
  });
});
