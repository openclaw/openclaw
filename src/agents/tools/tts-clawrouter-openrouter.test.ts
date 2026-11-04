import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { withServer, withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.js";
import { invokeTalkSpeakDirect } from "../../gateway/talk/test-helpers.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getSpeechProvider } from "../../tts/provider-registry.js";
import { synthesizeSpeech } from "../../tts/tts-synthesis.js";
import { createTtsTool } from "./tts-tool.js";

// Offline MP3 from the existing native speech fixture; no live synthesis.
const MP3 = Buffer.from(
  "//uQxAADwAABpAAAACAAADSAAAAETEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTQuMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//uSxDkDwAABpAAAACAAADSAAAAEVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUU0LjBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/7ksQ5A8AAAaQAAAAgAAA0gAAABFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=",
  "base64",
);
const MODELS = [
  "hexgrad/kokoro-82m",
  "elevenlabs/eleven-turbo-v2",
  "mistralai/voxtral-mini-tts-2603",
] as const;
type Call = { path: string; auth?: string; body: Record<string, unknown>; accept?: string };
type State = {
  kind: "native" | "manifest";
  model: string;
  eligible: boolean;
  observedAt?: string;
  authType?: string;
  path: string;
  format: string;
  route?: string;
  onCatalog?: (res: ServerResponse) => void;
  respond?: (res: ServerResponse) => void;
};
async function withFixture(
  run: (f: {
    cfg: OpenClawConfig;
    state: State;
    calls: Call[];
    catalogCalls: string[];
    tool: ReturnType<typeof createTtsTool>;
    speak: (options?: {
      signal?: AbortSignal;
      disableFallback?: boolean;
    }) => ReturnType<typeof synthesizeSpeech>;
  }) => Promise<void>,
) {
  await withTempHome(
    async (home) => {
      const state: State = {
        kind: "native",
        model: MODELS[0],
        eligible: true,
        path: "/v1/audio/speech",
        format: "openai.audio_speech",
      };
      const calls: Call[] = [];
      const catalogCalls: string[] = [];
      await withServer(
        (req, res) => {
          void (async () => {
            expect(req.headers["x-api-key"]).toBeUndefined();
            expect(req.headers["xi-api-key"]).toBeUndefined();
            if (req.url === "/v1/catalog") {
              catalogCalls.push(req.headers.authorization ?? "");
              res.setHeader("content-type", "application/json");
              if (state.onCatalog) {
                state.onCatalog(res);
                return;
              }
              const id = "openrouter/" + state.model;
              res.end(
                JSON.stringify({
                  version: "clawrouter.client-catalog.v1",
                  observedAt: state.observedAt ?? new Date().toISOString(),
                  scope: {
                    authType: state.authType ?? "proxy_key",
                    credentialId: "synthetic-speech-grant",
                  },
                  providers: [
                    {
                      id: "openrouter",
                      allowed: true,
                      executable: true,
                      nativeBaseUrl: "/v1/native/openrouter",
                      routes: [
                        {
                          endpoint: "speech",
                          path: state.path,
                          methods: ["POST"],
                          requestFormat: state.format,
                          responseFormat: "audio.binary",
                        },
                      ],
                      models: [{ id, upstream: state.model, capabilities: ["audio.speech"] }],
                      offers: [
                        {
                          endpoint: "speech",
                          modelId: id,
                          routeKind: state.kind,
                          route:
                            state.route ??
                            (state.kind === "native"
                              ? "/v1/native/openrouter" + state.path
                              : "/v1/proxy/openrouter/speech"),
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
            let body = "";
            for await (const chunk of req) {
              body += chunk;
            }
            calls.push({
              path: req.url ?? "",
              auth: req.headers.authorization,
              body: JSON.parse(body),
              accept: req.headers.accept,
            });
            res.setHeader("content-type", "audio/mpeg");
            if (!req.url?.startsWith("/fallback/") && state.respond) {
              state.respond(res);
            } else {
              res.setHeader("content-length", MP3.length);
              res.end(MP3);
            }
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
                  primary: "clawrouter/openrouter/hexgrad/kokoro-82m",
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
                },
                openai: {
                  baseUrl: baseUrl + "/fallback/v1",
                  apiKey: "synthetic-fallback-key",
                  models: [],
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            tts: {
              provider: "clawrouter",
              providers: {
                clawrouter: {
                  upstreamProvider: "openrouter",
                  provider: { zdr: true, data_collection: "deny" },
                },
                openai: {
                  apiKey: "synthetic-fallback-key",
                  baseUrl: baseUrl + "/fallback/v1",
                  model: "tts-1",
                  voice: "alloy",
                },
              },
            },
            talk: {
              provider: "clawrouter",
              providers: {
                clawrouter: { upstreamProvider: "openrouter", speakerVoiceId: "af_alloy" },
              },
            },
          };
          await run({
            cfg,
            state,
            calls,
            catalogCalls,
            tool: createTtsTool({ config: cfg }),
            speak: (options = {}) =>
              synthesizeSpeech({
                text: "Synthetic speech",
                cfg,
                prefsPath: home + "/speech-prefs.json",
                ...options,
              }),
          });
        },
      );
    },
    {
      env: {
        OPENROUTER_API_KEY: "synthetic-vendor-key-must-not-run",
        CLAWROUTER_API_KEY: undefined,
      },
    },
  );
}

describe("registered ClawRouter OpenRouter MP3 speech", () => {
  it.each(["native", "manifest"] as const)(
    "runs the actual TTS tool and Talk via %s",
    async (kind) => {
      await withFixture(async (f) => {
        f.state.kind = kind;
        const result = await f.tool.execute("speech", { text: "Synthetic speech" });
        const details = result.details as { audioPath: string; provider: string };
        expect(details.provider).toBe("clawrouter");
        expect(details.audioPath).toMatch(/\.mp3$/u);
        expect(await fs.readFile(details.audioPath)).toEqual(MP3);
        setRuntimeConfigSnapshot(f.cfg, f.cfg);
        try {
          const talk = await invokeTalkSpeakDirect({
            text: "Synthetic Talk",
            voiceId: "bf_emma",
            speed: 1.25,
          });
          expect(talk).toMatchObject({
            ok: true,
            payload: {
              provider: "clawrouter",
              audioBase64: MP3.toString("base64"),
              mimeType: "audio/mpeg",
              outputFormat: "mp3",
            },
          });
        } finally {
          clearRuntimeConfigSnapshot();
        }
        expect(f.catalogCalls).toEqual([
          "Bearer synthetic-router-key",
          "Bearer synthetic-router-key",
        ]);
        expect(f.calls).toHaveLength(2);
        for (const [i, call] of f.calls.entries()) {
          expect(call.path).toBe(
            kind === "native"
              ? "/v1/native/openrouter/v1/audio/speech"
              : "/v1/proxy/openrouter/speech",
          );
          expect(call.auth).toBe("Bearer synthetic-router-key");
          expect(call.accept).toBe("audio/mpeg");
          const body = kind === "manifest" ? call.body.body : call.body;
          expect(body).toMatchObject({
            model: MODELS[0],
            input: i ? "Synthetic Talk" : "Synthetic speech",
            voice: i ? "bf_emma" : "af_alloy",
            response_format: "mp3",
          });
          if (!i) {
            expect(body).toHaveProperty("provider", { zdr: true, data_collection: "deny" });
          }
        }
      });
    },
  );

  it.each(MODELS)("binds the catalog model %s", async (model) => {
    await withFixture(async (f) => {
      f.state.model = model;
      f.cfg.agents!.defaults!.voiceModel = { primary: "clawrouter/openrouter/" + model };
      expect(await f.speak()).toMatchObject({
        success: true,
        provider: "clawrouter",
        outputFormat: "mp3",
      });
      expect(f.calls[0]?.body.model).toBe(model);
    });
  });

  it("preserves a working fallback after a proven pre-egress denial", async () => {
    await withFixture(async (f) => {
      f.state.eligible = false;
      expect(await f.speak()).toMatchObject({
        success: true,
        provider: "openai",
        fallbackFrom: "clawrouter",
      });
      expect(f.calls).toMatchObject([
        { path: "/fallback/v1/audio/speech", auth: "Bearer synthetic-fallback-key" },
      ]);
    });
  });

  it.each(["text", "partial", "empty", "redirect", "lost", "oversized"] as const)(
    "never pays an alternate provider after %s output",
    async (failure) => {
      await withFixture(async (f) => {
        f.state.respond = (res) => {
          if (failure === "lost") {
            res.destroy();
            return;
          }
          if (failure === "redirect") {
            res.statusCode = 307;
            res.setHeader("location", "/fallback/v1/audio/speech");
            res.end();
            return;
          }
          if (failure === "partial") {
            res.statusCode = 206;
          }
          if (failure === "text") {
            res.setHeader("content-type", "text/plain");
          }
          res.end(
            failure === "empty"
              ? Buffer.alloc(0)
              : failure === "oversized"
                ? Buffer.alloc(16 * 1024 * 1024 + 1)
                : failure === "text"
                  ? "unusable"
                  : MP3,
          );
        };
        await expect(f.tool.execute("speech", { text: "Synthetic speech" })).rejects.toThrow();
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]?.path).toBe("/v1/native/openrouter/v1/audio/speech");
      });
    },
  );

  it.each(["before", "catalog", "post", "body"] as const)(
    "threads actual caller abort during %s without replay",
    async (phase) => {
      await withFixture(async (f) => {
        const abort = new AbortController();
        const reached = createDeferredCore();
        if (phase === "before") {
          abort.abort(new Error("synthetic caller stopped"));
        }
        if (phase === "catalog") {
          f.state.onCatalog = (res) => {
            res.write('{"version":');
            reached.resolve();
          };
        }
        if (phase === "post" || phase === "body") {
          f.state.respond = (res) => {
            if (phase === "body") {
              res.write(MP3.subarray(0, 128));
            }
            reached.resolve();
          };
        }
        const pending = f.tool.execute("speech", { text: "Synthetic speech" }, abort.signal);
        const rejected = expect(pending).rejects.toThrow();
        if (phase !== "before") {
          await reached.promise;
          abort.abort(new Error("synthetic caller stopped"));
        }
        await rejected;
        expect(f.calls).toHaveLength(phase === "post" || phase === "body" ? 1 : 0);
        if (phase === "before") {
          expect(f.catalogCalls).toHaveLength(0);
        }
      });
    },
  );

  it.each([
    { observedAt: "2000-01-01T00:00:00Z" },
    { authType: "access" },
    { path: "/foreign" },
    { route: "https://foreign.example/v1/audio/speech" },
    { format: "unknown.speech" },
    { model: "google/gemini-3.1-flash-tts-preview" },
  ])("denies an unqualified offer %j before POST", async (bad) => {
    await withFixture(async (f) => {
      Object.assign(f.state, bad);
      f.cfg.agents!.defaults!.voiceModel = { primary: "clawrouter/openrouter/hexgrad/kokoro-82m" };
      expect(await f.speak({ disableFallback: true })).toMatchObject({ success: false });
      expect(f.calls).toHaveLength(0);
    });
  });

  it.each([
    { responseFormat: "pcm" },
    { responseFormat: "opus" },
    { provider: { order: ["unknown"] } },
    { speed: 5 },
    { model: "openai/tts-1" },
  ])("rejects unsupported settings %j before discovery", async (bad) => {
    await withFixture(async (f) => {
      const provider = getSpeechProvider("clawrouter", f.cfg)!;
      await expect(
        provider.synthesize({
          cfg: f.cfg,
          providerConfig: { upstreamProvider: "openrouter", ...bad },
          text: "Synthetic speech",
          target: "audio-file",
          timeoutMs: 30000,
        }),
      ).rejects.toThrow();
      expect(f.catalogCalls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    });
  });

  it.each(["missing-key", "foreign-profile"] as const)(
    "does not borrow a vendor credential for %s",
    async (failure) => {
      await withFixture(async (f) => {
        if (failure === "missing-key") {
          f.cfg.models!.providers!.clawrouter!.apiKey = undefined;
        } else {
          f.cfg.tts!.providers!.clawrouter!.profileId = "synthetic-foreign-profile";
        }
        expect(await f.speak({ disableFallback: true })).toMatchObject({ success: false });
        expect(f.catalogCalls).toHaveLength(0);
        expect(f.calls).toHaveLength(0);
      });
    },
  );

  it("preserves the qualified text envelope above OpenAI's fixed limit", async () => {
    await withFixture(async (f) => {
      f.cfg.tts!.maxTextLength = 32768;
      const text = "a".repeat(5000);
      await f.tool.execute("speech", { text });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.body.input).toBe(text);
    });
  });

  it("never labels MP3 as telephony PCM", async () => {
    await withFixture(async (f) => {
      const provider = getSpeechProvider("clawrouter", f.cfg)!;
      await expect(
        provider.synthesizeTelephony!({
          cfg: f.cfg,
          providerConfig: { upstreamProvider: "openrouter" },
          text: "Synthetic speech",
          timeoutMs: 30000,
        }),
      ).rejects.toThrow(/telephony/u);
      expect(f.calls).toHaveLength(0);
      expect(f.catalogCalls).toHaveLength(0);
    });
  });
});
