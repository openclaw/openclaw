import { text } from "node:stream/consumers";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withServer } from "../plugin-sdk/test-env.js";
import { resolvePluginCapabilityCatalogContext } from "../plugins/loader-runtime-load.js";
import { acquirePluginRegistryForInspection } from "../plugins/loader.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { synthesizeSpeech } from "./tts-synthesis.js";

it("retires the registered ClawRouter speech body after transport abort", async () => {
  const key = "synthetic-speech-proxy-key";
  const phaseAbort = new AbortController();
  const secondReadStarted = Promise.withResolvers<void>();
  const secondReadSettled = Promise.withResolvers<void>();
  const responseClosed = Promise.withResolvers<void>();
  const socketClosed = Promise.withResolvers<void>();
  const restore: Array<() => void> = [];
  let posts = 0;
  let catalogGets = 0;
  let matchedFetches = 0;
  let firstChunkConsumed = false;
  let secondPending = false;
  let readerUnlocked = false;
  let releaseCalls = 0;
  let releaseCompleted = false;
  let responseCloseObserved = false;
  let socketCloseObserved = false;
  let serverError: unknown;
  let observedBody: ReadableStream<Uint8Array> | undefined;
  let boundRegistry: PluginRegistry | undefined;

  // Observe the actual post-guard body, including Bun's cancellation wrapper.
  function observeBody(body: ReadableStream<Uint8Array>) {
    observedBody = body;
    const descriptor = Object.getOwnPropertyDescriptor(body, "getReader");
    const getReader: () => ReadableStreamDefaultReader<Uint8Array> = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      configurable: true,
      value(this: ReadableStream<Uint8Array>, ...args: []) {
        expect(this).toBe(body);
        const reader = getReader.apply(this, args);
        const readDescriptor = Object.getOwnPropertyDescriptor(reader, "read");
        const unlockDescriptor = Object.getOwnPropertyDescriptor(reader, "releaseLock");
        const read = reader.read.bind(reader);
        const unlock = reader.releaseLock.bind(reader);
        let reads = 0;
        Object.defineProperty(reader, "read", {
          configurable: true,
          value(this: ReadableStreamDefaultReader<Uint8Array>, ...readArgs: []) {
            expect(this).toBe(reader);
            const pending = read.apply(this, readArgs);
            reads += 1;
            if (reads === 1) {
              void pending.then(
                (chunk) => {
                  firstChunkConsumed = !chunk.done && chunk.value.byteLength > 0;
                },
                () => {},
              );
            } else if (reads === 2) {
              secondPending = true;
              const settled = () => {
                secondPending = false;
                secondReadSettled.resolve();
              };
              // Both reactions precede the milestone; an already-settled read cannot pass.
              void pending.then(settled, settled);
              secondReadStarted.resolve();
            }
            return pending;
          },
        });
        Object.defineProperty(reader, "releaseLock", {
          configurable: true,
          value(this: ReadableStreamDefaultReader<Uint8Array>, ...unlockArgs: []) {
            expect(this).toBe(reader);
            const result = unlock.apply(this, unlockArgs);
            readerUnlocked = !body.locked;
            return result;
          },
        });
        restore.push(() => {
          if (readDescriptor) {
            Object.defineProperty(reader, "read", readDescriptor);
          } else {
            Reflect.deleteProperty(reader, "read");
          }
          if (unlockDescriptor) {
            Object.defineProperty(reader, "releaseLock", unlockDescriptor);
          } else {
            Reflect.deleteProperty(reader, "releaseLock");
          }
        });
        return reader;
      },
    });
    restore.push(() => {
      if (descriptor) {
        Object.defineProperty(body, "getReader", descriptor);
      } else {
        Reflect.deleteProperty(body, "getReader");
      }
    });
  }

  await withOpenClawTestState({ label: "clawrouter-speech-retirement" }, async (state) => {
    await withServer(
      (request, response) => {
        void (async () => {
          expect(request.headers.authorization).toBe(`Bearer ${key}`);
          if (request.method === "GET" && request.url === "/v1/catalog") {
            catalogGets += 1;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                version: "clawrouter.client-catalog.v1",
                observedAt: new Date().toISOString(),
                scope: {
                  authType: "proxy_key",
                  credentialId: "synthetic-speech",
                  principalId: null,
                },
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
                        routeKind: "native",
                        route: "/v1/native/openai/v1/audio/speech",
                        transport: "http",
                        eligible: true,
                        affordability: "request-dependent",
                      },
                    ],
                  },
                ],
              }),
            );
            return;
          }
          expect(request.method).toBe("POST");
          expect(request.url).toBe("/v1/native/openai/v1/audio/speech");
          posts += 1;
          response.once("close", () => {
            responseCloseObserved = true;
            responseClosed.resolve();
          });
          request.socket.once("close", () => {
            socketCloseObserved = true;
            socketClosed.resolve();
          });
          expect(JSON.parse(await text(request))).toMatchObject({
            model: "tts-1",
            response_format: "mp3",
          });
          response.setHeader("content-type", "audio/mpeg");
          response.write(Buffer.from([0x49]));
        })().catch((error: unknown) => {
          serverError = error;
          response.destroy();
        });
      },
      async (origin) => {
        const cfg: OpenClawConfig = {
          plugins: { allow: ["clawrouter"], entries: { clawrouter: { enabled: true } } },
          agents: { defaults: { voiceModel: "clawrouter/openai/tts-1" } },
          models: {
            providers: {
              clawrouter: {
                baseUrl: origin + "/v1",
                apiKey: key,
                models: [],
                request: { allowPrivateNetwork: true },
              },
            },
          },
          tts: { provider: "clawrouter", providers: { clawrouter: {} } },
        };
        const native = resolvePluginCapabilityCatalogContext();
        const inspection = await acquirePluginRegistryForInspection({
          config: cfg,
          onlyPluginIds: ["clawrouter"],
          capabilityCatalogContext: {
            ...native,
            async fetchWithSsrFGuard(params) {
              if (
                params.url !== origin + "/v1/native/openai/v1/audio/speech" ||
                params.init?.method !== "POST"
              ) {
                return native.fetchWithSsrFGuard(params);
              }
              expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(boundRegistry);
              expect(params.auditContext).toBe("clawrouter.speech");
              matchedFetches += 1;
              const originalSignal = params.signal ?? params.init?.signal;
              const result = await native.fetchWithSsrFGuard({
                ...params,
                signal: originalSignal
                  ? AbortSignal.any([originalSignal, phaseAbort.signal])
                  : phaseAbort.signal,
              });
              if (!result.response.body) {
                throw new Error("Registered speech response has no body");
              }
              observeBody(result.response.body);
              return {
                ...result,
                release() {
                  releaseCalls += 1;
                  const completion = result.release();
                  void completion.then(
                    () => {
                      releaseCompleted = true;
                    },
                    () => {},
                  );
                  return completion;
                },
              };
            },
          },
        });
        boundRegistry = inspection.registry;
        let settlement: Promise<unknown> | undefined;
        try {
          expect(inspection.registry.plugins).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: "clawrouter", status: "loaded" }),
            ]),
          );
          expect(inspection.registry.speechProviders).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                pluginId: "clawrouter",
                provider: expect.objectContaining({ id: "clawrouter" }),
              }),
            ]),
          );
          const synthesis = withPluginRuntimeRegistryScope(inspection.registry, () =>
            synthesizeSpeech({
              text: "Synthetic speech retirement",
              cfg,
              prefsPath: state.path("tts-prefs.json"),
              timeoutMs: 5000,
              disableFallback: true,
            }),
          );
          const outcome = synthesis.then(
            (result) => ({ kind: "result" as const, result }),
            (error: unknown) => ({ kind: "error" as const, error }),
          );
          settlement = outcome;
          const first = await Promise.race([
            secondReadStarted.promise.then(() => "pending-read"),
            outcome.then(() => "premature-settlement"),
          ]);
          expect(first).toBe("pending-read");
          expect(firstChunkConsumed).toBe(true);
          expect(secondPending).toBe(true);
          phaseAbort.abort(new Error("fixture speech transport abort"));
          const result = await outcome;
          expect(result.kind).toBe("result");
          if (result.kind !== "result") {
            throw result.error;
          }
          expect(result.result).toMatchObject({
            success: false,
            error: expect.stringContaining("fixture speech transport abort"),
          });
          expect(result.result.audioBuffer).toBeUndefined();
          await Promise.all([
            secondReadSettled.promise,
            responseClosed.promise,
            socketClosed.promise,
          ]);
          expect(serverError).toBeUndefined();
          expect(catalogGets).toBe(1);
          expect(posts).toBe(1);
          expect(matchedFetches).toBe(1);
          expect(secondPending).toBe(false);
          expect(readerUnlocked).toBe(true);
          expect(observedBody?.locked).toBe(false);
          expect(releaseCalls).toBe(1);
          expect(releaseCompleted).toBe(true);
          expect(responseCloseObserved && socketCloseObserved).toBe(true);
        } finally {
          // Emergency cleanup occurs after the verdict and cannot satisfy the assertions above.
          phaseAbort.abort();
          await settlement;
          for (const undo of restore.toReversed()) {
            undo();
          }
          await inspection.release();
        }
      },
    );
  });
});
