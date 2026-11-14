import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getSpeechProvider } from "../../tts/provider-registry.js";
import { mergeProviderConfigWithPersona } from "../../tts/tts-provider-resolution.js";
import { resolveTtsConfig } from "../../tts/tts-settings.js";
import { createTtsTool } from "./tts-tool.js";

const models = [
  "gemini-3.1-flash-tts-preview",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
] as const;
const pcm = Buffer.from([0, 0, 255, 127]);
type Call = { path: string; auth?: string; body: unknown; vendorHeader: boolean };
type State = {
  model: string;
  eligible: boolean;
  onCatalog?: (res: ServerResponse) => void;
  respond?: (res: ServerResponse) => void;
};

async function withFixture(
  run: (f: {
    cfg: OpenClawConfig;
    state: State;
    calls: Call[];
    catalogKeys: string[];
    tool: ReturnType<typeof createTtsTool>;
    direct: (
      signal?: AbortSignal,
      timeoutMs?: number,
    ) => ReturnType<NonNullable<ReturnType<typeof getSpeechProvider>>["synthesize"]>;
  }) => Promise<void>,
  model: string = models[0],
) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-14T12:00:00Z"));
  try {
    await withTempHome(
      async () => {
        const state: State = { model, eligible: true },
          calls: Call[] = [],
          catalogKeys: string[] = [];
        await withServer(
          (req, res) => {
            void (async () => {
              const interactions = state.model.startsWith("gemini-3.8-");
              const endpoint = interactions ? "speech_interactions" : "speech_generate_content";
              const path = interactions
                ? "/v1beta/interactions"
                : "/v1beta/models/${model}:generateContent";
              const id = "google/" + state.model;
              if (req.url === "/v1/catalog") {
                catalogKeys.push(req.headers.authorization ?? "");
                res.setHeader("content-type", "application/json");
                if (state.onCatalog) {
                  state.onCatalog(res);
                  return;
                }
                res.end(
                  JSON.stringify({
                    version: "clawrouter.client-catalog.v1",
                    observedAt: new Date(Date.now()).toISOString(),
                    scope: { authType: "proxy_key", credentialId: "synthetic-google-speech" },
                    providers: [
                      {
                        id: "google",
                        allowed: true,
                        executable: true,
                        nativeBaseUrl: "/v1/native/google",
                        routes: [
                          {
                            endpoint,
                            path,
                            methods: ["POST"],
                            requestFormat: "google." + endpoint,
                            responseFormat: "google." + endpoint,
                          },
                        ],
                        models: [{ id, upstream: state.model, capabilities: ["audio.speech"] }],
                        offers: [
                          {
                            endpoint,
                            modelId: id,
                            routeKind: interactions ? "manifest" : "native",
                            route: interactions
                              ? "/v1/proxy/google/speech_interactions"
                              : "/v1/native/google" + path,
                            transport: "http",
                            eligible: state.eligible,
                            affordability: "request-dependent",
                          },
                        ],
                      },
                    ],
                  }),
                );
                return;
              }
              let text = "";
              for await (const chunk of req) {
                text += chunk;
              }
              calls.push({
                path: req.url ?? "",
                auth: req.headers.authorization,
                body: JSON.parse(text),
                vendorHeader:
                  req.headers["x-goog-api-key"] !== undefined ||
                  req.headers["x-api-key"] !== undefined,
              });
              if (state.respond) {
                state.respond(res);
                return;
              }
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify(
                  interactions
                    ? {
                        model: state.model,
                        status: "completed",
                        steps: [
                          {
                            type: "model_output",
                            content: [
                              {
                                type: "audio",
                                mime_type: "audio/l16",
                                data: pcm.toString("base64"),
                              },
                            ],
                          },
                        ],
                      }
                    : {
                        candidates: [
                          {
                            finishReason: "STOP",
                            content: {
                              role: "model",
                              parts: [
                                {
                                  inlineData: {
                                    mimeType: "audio/L16;codec=pcm;rate=24000",
                                    data: pcm.toString("base64"),
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                ),
              );
            })().catch((error: unknown) =>
              res.destroy(error instanceof Error ? error : new Error(String(error))),
            );
          },
          async (baseUrl) => {
            const cfg: OpenClawConfig = {
              plugins: {
                allow: ["clawrouter", "openai"],
                entries: { clawrouter: { enabled: true }, openai: { enabled: true } },
              },
              agents: {
                defaults: {
                  voiceModel: {
                    primary: "clawrouter/google/" + state.model,
                    fallbacks: ["openai/tts-1"],
                  },
                },
              },
              models: {
                providers: {
                  clawrouter: {
                    baseUrl,
                    apiKey: "synthetic-router-key",
                    models: [],
                    request: { allowPrivateNetwork: true },
                    headers: {
                      "x-goog-api-key": "synthetic-not-a-vendor-key",
                      "x-api-key": "synthetic-not-a-vendor-key",
                    },
                  },
                  openai: {
                    baseUrl: baseUrl + "/fallback/v1",
                    apiKey: "synthetic-fallback",
                    models: [],
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
              tts: {
                provider: "clawrouter",
                providers: {
                  clawrouter: {
                    upstreamProvider: "google",
                    model: "google/" + state.model,
                    voice: "Kore",
                  },
                  openai: {
                    baseUrl: baseUrl + "/fallback/v1",
                    apiKey: "synthetic-fallback",
                    model: "tts-1",
                    voice: "alloy",
                  },
                },
              },
            };
            await run({
              cfg,
              state,
              calls,
              catalogKeys,
              tool: createTtsTool({ config: cfg }),
              direct: (signal, timeoutMs = 5000) =>
                getSpeechProvider("clawrouter", cfg)!.synthesize({
                  cfg,
                  providerConfig: cfg.tts!.providers!.clawrouter!,
                  text: "Synthetic speech",
                  target: "audio-file",
                  signal,
                  timeoutMs,
                }),
            });
          },
        );
      },
      {
        env: {
          CLAWROUTER_API_KEY: undefined,
          GOOGLE_API_KEY: "synthetic-vendor-must-not-run",
          GEMINI_API_KEY: "synthetic-vendor-must-not-run",
        },
      },
    );
  } finally {
    clock.mockRestore();
  }
}

describe("registered ClawRouter Google speech", () => {
  it.each([
    ["voice", "speakerVoiceId", "model", "modelId"],
    ["voiceId", "speakerVoice", "modelId", "model"],
  ])(
    "persona replaces inherited %s with %s before readiness",
    async (baseVoice, nextVoice, baseModel, nextModel) => {
      await withFixture(async (f) => {
        f.cfg.tts!.providers!.clawrouter = {
          upstreamProvider: "google",
          [baseVoice]: "Kore",
          [baseModel]: "google/" + models[0],
        };
        f.cfg.tts!.persona = "narrator";
        f.cfg.tts!.personas = {
          narrator: {
            providers: {
              clawrouter: {
                [nextVoice]: " Puck ",
                [nextModel]: " google/" + models[3] + " ",
                apiKey: "synthetic-persona-key",
              },
            },
          },
        };
        const result = await f.tool.execute("persona", { text: "Synthetic speech" });
        expect(result.details).toMatchObject({ provider: "clawrouter" });
        expect(f.catalogKeys).toEqual(["Bearer synthetic-persona-key"]);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]).toMatchObject({
          auth: "Bearer synthetic-persona-key",
          body: {
            body: {
              model: models[3],
              generation_config: { speech_config: [{ voice: "Puck" }] },
            },
          },
        });
      }, models[3]);
    },
  );

  it.each([
    { voice: "Kore", voiceName: "Puck" },
    { model: "google/" + models[0], modelId: "google/" + models[3] },
    { speakerVoice: "Kore", speakerVoiceId: "Puck" },
    { voice: null },
    { model: null },
    { voice: "" },
    { voice: "   " },
    { model: "" },
    { model: "   " },
  ])("persona keeps invalid authored aliases visible: %j", async (overrides) => {
    await withFixture(async (f) => {
      f.cfg.tts!.persona = "narrator";
      f.cfg.tts!.personas = {
        narrator: { fallbackPolicy: "fail", providers: { clawrouter: overrides } },
      };
      await expect(f.tool.execute("persona", { text: "Synthetic speech" })).rejects.toThrow();
      expect(f.catalogKeys).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    });
  });

  it.each([
    { voice: " Puck ", voiceName: "Puck", speakerVoiceId: "Puck" },
    { voiceId: undefined, modelId: undefined },
  ])("persona admits equal or undefined aliases: %j", async (overrides) => {
    await withFixture(async (f) => {
      f.cfg.tts!.persona = "narrator";
      f.cfg.tts!.personas = { narrator: { providers: { clawrouter: overrides } } };
      await f.tool.execute("persona", { text: "Synthetic speech" });
      expect(f.catalogKeys).toEqual(["Bearer synthetic-router-key"]);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.body).toMatchObject({
        generationConfig: {
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName:
                  overrides.voiceId === undefined && !("voice" in overrides) ? "Kore" : "Puck",
              },
            },
          },
        },
      });
    });
  });

  function mergePersona(
    base: Record<string, unknown>,
    authored: Record<string, unknown>,
    provider = "clawrouter",
  ) {
    const config = resolveTtsConfig({
      tts: {
        providers: { [provider]: base },
        personas: {
          Narrator: { providers: { [provider]: authored } },
        },
      },
    });
    const providerConfig = config.providerConfigs[provider === "edge" ? "microsoft" : provider];
    if (!providerConfig) {
      throw new Error("Missing normalized test provider");
    }
    return mergeProviderConfigWithPersona({
      providerId: provider,
      providerConfig,
      persona: config.personas.narrator,
    });
  }

  it("normalizes persona strings and IDs without hiding conflicts or changing base normalization", () => {
    const base = Object.freeze({ speakerVoice: " Base ", voice: "legacy", model: "base-model" });
    const authored = Object.freeze({
      voice: " Kore ",
      voiceName: "Puck",
      voiceId: undefined,
      speakerVoiceId: null,
      model: " one ",
      modelId: "two",
    });
    const merged = mergePersona(base, authored, "edge");
    expect(merged.personaBinding).toBe("applied");
    expect(merged.personaProviderConfig).toMatchObject({
      voice: "Kore",
      voiceName: "Puck",
      voiceId: undefined,
      speakerVoiceId: null,
      model: "one",
      modelId: "two",
    });
    expect(Object.hasOwn(merged.personaProviderConfig!, "voiceId")).toBe(true);
    expect(
      resolveTtsConfig({ tts: { providers: { edge: base } } }).providerConfigs.microsoft,
    ).toMatchObject({ speakerVoice: "Base", voice: "Base", voiceName: "Base" });
    expect(base).toEqual({ speakerVoice: " Base ", voice: "legacy", model: "base-model" });
    expect(authored.voice).toBe(" Kore ");
  });

  it("overlays only selected families, preserves credentials, and replaces nested values", () => {
    const nested = Object.freeze({ old: true }),
      replacement = Object.freeze({ next: true });
    const base = Object.freeze({
      voice: "Kore",
      model: "original",
      apiKey: "synthetic-base",
      nested,
    });
    const overlay = mergePersona(base, { modelId: "next", nested: replacement });
    const changed = overlay.providerConfig;
    expect(changed).toMatchObject({ voice: "Kore", modelId: "next", apiKey: "synthetic-base" });
    expect(changed).not.toHaveProperty("model");
    expect(changed.nested).toBe(overlay.personaProviderConfig?.nested);
    expect(changed.nested).toEqual(replacement);
    expect(base.nested).toBe(nested);
    const unchanged = mergePersona(base, { voiceId: undefined, modelId: undefined }).providerConfig;
    expect(unchanged).toMatchObject({ voice: "Kore", model: "original", apiKey: "synthetic-base" });
    expect(mergePersona(base, { apiKey: "synthetic-persona" }).providerConfig).toMatchObject({
      voice: "Kore",
      model: "original",
      apiKey: "synthetic-persona",
    });
    const inheritedOnly = { __proto__: { voice: "Puck", model: "other" } };
    expect(
      mergeProviderConfigWithPersona({
        providerConfig: base,
        providerId: "clawrouter",
        persona: { id: "narrator", providers: { clawrouter: inheritedOnly } },
      }).providerConfig,
    ).toEqual(base);
    for (const persona of [undefined, { id: "missing", providers: { other: {} } }]) {
      const result = mergeProviderConfigWithPersona({
        providerConfig: base,
        persona,
        providerId: "clawrouter",
      });
      expect(result.providerConfig).toBe(base);
      expect(result.personaBinding).toBe(persona ? "missing" : "none");
    }
  });

  it.each([
    ["openai", "openai/tts-1", "alloy", "nova"],
    ["gradium", undefined, "voice_old", "voice_new"],
    ["azure-speech", undefined, "en-US-JennyNeural", "en-US-AriaNeural"],
    ["elevenlabs", "eleven_multilingual_v2", "21m00Tcm4TlvDq8ikWAM", "EXAVITQu4vr4xnSDxMaL"],
    ["openrouter", "openrouter/hexgrad/kokoro-82m", "af_alloy", "af_bella"],
  ] as const)(
    "preserves %s persona name/ID selection",
    async (upstreamProvider, model, oldVoice, voice) => {
      await withFixture(async (f) => {
        const provider = getSpeechProvider("clawrouter", f.cfg)!;
        for (const [baseVoice, authored] of [
          [{ speakerVoice: oldVoice }, { speakerVoiceId: voice }],
          [{ speakerVoiceId: oldVoice }, { voiceName: voice }],
          [{ voice: oldVoice }, { speakerVoice: voice, speakerVoiceId: oldVoice }],
        ]) {
          const merged = mergePersona({ upstreamProvider, model, ...baseVoice }, authored!);
          const result = provider.resolveConfig!({
            cfg: f.cfg,
            rawConfig: { providers: { clawrouter: merged.providerConfig } },
            timeoutMs: 5000,
          });
          expect(result.voice).toBe(voice);
          expect(result.upstreamProvider).toBe(upstreamProvider);
        }
        expect(f.catalogKeys).toHaveLength(0);
        expect(f.calls).toHaveLength(0);
      });
    },
  );
  it.each(models)("the actual TTS tool delivers WAV for %s", async (model) => {
    await withFixture(async (f) => {
      const result = await f.tool.execute("google-speech", { text: "Synthetic speech" });
      const details = result.details as {
        provider: string;
        audioPath: string;
        media: { audioAsVoice?: boolean };
      };
      expect(details.provider).toBe("clawrouter");
      expect(details.audioPath).toMatch(/\.wav$/u);
      expect(details.media.audioAsVoice).not.toBe(true);
      expect((await fs.readFile(details.audioPath)).toString("hex")).toBe(
        "524946462800000057415645666d74201000000001000100c05d000080bb00000200100064617461040000000000ff7f",
      );
      expect(f.catalogKeys).toEqual(["Bearer synthetic-router-key"]);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({
        auth: "Bearer synthetic-router-key",
        vendorHeader: false,
      });
      const interactions = model.startsWith("gemini-3.8-");
      expect(f.calls[0]?.path).toBe(
        interactions
          ? "/v1/proxy/google/speech_interactions"
          : `/v1/native/google/v1beta/models/${model}:generateContent`,
      );
      expect(f.calls[0]?.body).toEqual(
        interactions
          ? {
              body: {
                model,
                store: false,
                input: [
                  { type: "user_input", content: [{ type: "text", text: "Synthetic speech" }] },
                ],
                generation_config: { speech_config: [{ voice: "Kore" }] },
                response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
              },
            }
          : {
              contents: [{ role: "user", parts: [{ text: "Synthetic speech" }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
              },
            },
      );
    }, model);
  });

  it("keeps selected proxy keys isolated and refreshes eligibility on each synthesis", async () => {
    await withFixture(async (f) => {
      f.cfg.tts!.providers!.clawrouter!.apiKey = "synthetic-owner-a";
      await f.direct();
      f.cfg.tts!.providers!.clawrouter!.apiKey = "synthetic-owner-b";
      await f.direct();
      f.state.eligible = false;
      await expect(f.direct()).rejects.toThrow("one eligible");
      expect(f.catalogKeys).toEqual([
        "Bearer synthetic-owner-a",
        "Bearer synthetic-owner-b",
        "Bearer synthetic-owner-b",
      ]);
      expect(f.calls.map((call) => call.auth)).toEqual([
        "Bearer synthetic-owner-a",
        "Bearer synthetic-owner-b",
      ]);
    }, models[3]);
  });

  it.each(["malformed", "later-block", "redirect", "non200", "partial", "encoding"])(
    "never buys a fallback after %s response",
    async (failure) => {
      await withFixture(async (f) => {
        f.state.respond = (res) => {
          res.setHeader("content-type", "application/json");
          if (failure === "redirect") {
            res.statusCode = 307;
            res.setHeader("location", "/fallback/v1/audio/speech");
          }
          if (failure === "non200") {
            res.statusCode = 503;
          }
          if (failure === "partial") {
            res.statusCode = 206;
          }
          if (failure === "encoding") {
            res.setHeader("content-encoding", "unsupported");
          }
          res.end(
            failure === "malformed"
              ? "{broken"
              : JSON.stringify({
                  candidates: [
                    {
                      finishReason: "STOP",
                      content: {
                        parts: [
                          { inlineData: { mimeType: "audio/l16", data: "AAD/fw==" } },
                          { inlineData: { mimeType: "audio/l16", data: "invalid" } },
                        ],
                      },
                    },
                  ],
                }),
          );
        };
        await expect(
          f.tool.execute("google-speech", { text: "Synthetic speech" }),
        ).rejects.toThrow();
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]?.path).not.toContain("fallback");
      });
    },
  );

  it.each(["catalog-headers", "catalog-body", "post-headers", "post-body"])(
    "original caller abort closes the actual %s request before fixture teardown",
    async (phase) => {
      await withFixture(async (f) => {
        const reached = createDeferredCore(),
          closed = createDeferredCore(),
          caller = new AbortController();
        const hold = (res: ServerResponse) => {
          res.once("close", () => closed.resolve());
          if (phase.endsWith("body")) {
            res.setHeader("content-type", "application/json");
            res.write('{"incomplete":');
          }
          reached.resolve();
        };
        if (phase.startsWith("catalog")) {
          f.state.onCatalog = hold;
        } else {
          f.state.respond = hold;
        }
        const pending = f.tool.execute(
          "google-speech",
          { text: "Synthetic speech" },
          caller.signal,
        );
        const rejected = expect(pending).rejects.toThrow("synthetic caller stopped");
        await reached.promise;
        caller.abort(new Error("synthetic caller stopped"));
        await rejected;
        await closed.promise;
        expect(f.calls).toHaveLength(phase.startsWith("catalog") ? 0 : 1);
      });
    },
  );

  it("the same operation deadline ends a stalled discovery without a paid POST", async () => {
    await withFixture(async (f) => {
      const closed = createDeferredCore();
      f.state.onCatalog = (res) => {
        res.once("close", () => closed.resolve());
        res.write('{"incomplete":');
      };
      await expect(f.direct(undefined, 250)).rejects.toThrow();
      await closed.promise;
      expect(f.calls).toHaveLength(0);
    }, models[3]);
  });

  it.each(["missing-key", "unavailable-profile"])(
    "cannot borrow a Google credential for %s",
    async (failure) => {
      await withFixture(async (f) => {
        if (failure === "missing-key") {
          f.cfg.models!.providers!.clawrouter!.apiKey = undefined;
        } else {
          f.cfg.tts!.providers!.clawrouter!.profileId = "synthetic-missing-profile";
        }
        await expect(f.direct()).rejects.toThrow();
        expect(f.catalogKeys).toHaveLength(0);
        expect(f.calls).toHaveLength(0);
      });
    },
  );

  it.each([true, false])(
    "Talk replaces inherited Google aliases (explicit provider: %s)",
    async (explicit) => {
      await withFixture(async (f) => {
        const provider = getSpeechProvider("clawrouter", f.cfg)!;
        const baseTtsConfig = {
          providers: {
            clawrouter: {
              upstreamProvider: "google",
              model: "google/" + models[0],
              modelId: "google/" + models[0],
              voice: "Kore",
              voiceName: "Kore",
              speakerVoice: "Kore",
            },
          },
        };
        const talkProviderConfig = {
          ...(explicit ? { upstreamProvider: "google" } : {}),
          modelId: "google/" + models[3],
          speakerVoiceId: "Puck",
        };
        expect(
          provider.resolveTalkConfig!({
            cfg: f.cfg,
            baseTtsConfig,
            talkProviderConfig,
            timeoutMs: 5000,
          }),
        ).toMatchObject({
          upstreamProvider: "google",
          model: "google/" + models[3],
          voice: "Puck",
        });
        expect(() =>
          provider.resolveTalkConfig!({
            cfg: f.cfg,
            baseTtsConfig,
            talkProviderConfig: { ...talkProviderConfig, voice: "conflict" },
            timeoutMs: 5000,
          }),
        ).toThrow("unambiguous");
        expect(f.catalogKeys).toHaveLength(0);
      });
    },
  );

  it("does not inherit alloy when Talk switches from OpenAI to Google", async () => {
    await withFixture(async (f) => {
      const provider = getSpeechProvider("clawrouter", f.cfg)!;
      const baseTtsConfig = { providers: { clawrouter: { voice: "alloy" } } };
      expect(() =>
        provider.resolveTalkConfig!({
          cfg: f.cfg,
          baseTtsConfig,
          talkProviderConfig: { upstreamProvider: "google", model: "google/" + models[3] },
          timeoutMs: 5000,
        }),
      ).toThrow("explicit single voice");
      const config = provider.resolveTalkConfig!({
        cfg: f.cfg,
        baseTtsConfig,
        talkProviderConfig: {
          upstreamProvider: "google",
          model: "google/" + models[3],
          speakerVoiceId: "Kore",
        },
        timeoutMs: 5000,
      });
      expect(config).toMatchObject({ model: "google/" + models[3], voice: "Kore" });
      expect(f.catalogKeys).toHaveLength(0);
    });
  });
});
