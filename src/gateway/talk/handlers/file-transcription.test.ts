import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { MediaUnderstandingModelConfig } from "../../../config/types.tools.js";
import { acquireStateDatabaseSchemaLease } from "../../../infra/gateway-state-owner.js";
import type {
  AudioTranscriptionConfigContext,
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from "../../../media-understanding/types.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../../plugins/capability-provider.types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { talkHandlers } from "./index.js";
import { expectRespondError, expectRespondOk } from "./responses.test-support.js";
import { talkSessionHandlers } from "./session.js";

const cfg: OpenClawConfig = {
  models: {
    providers: {
      "local-stt": {
        baseUrl: "https://unused.invalid",
        apiKey: "synthetic-fixture-key",
        models: [],
      },
    },
  },
  tools: {
    media: {
      audio: { enabled: true, maxBytes: 8192 },
      models: [{ provider: "local-stt", model: "whisper", capabilities: ["audio"] }],
    },
  },
};

function fileRpc(
  config = cfg,
  handlers: GatewayRequestHandlers = talkSessionHandlers,
  client?: unknown,
) {
  const events: Array<{ type?: string; text?: string; message?: string }> = [];
  const context = {
    getRuntimeConfig: () => config,
    broadcastToConnIds: (_event: string, payload: (typeof events)[number]) => events.push(payload),
    logGateway: { warn: vi.fn() },
  };
  const invoke = createTalkHandlerCaller(handlers);
  const start = (method: string, params: Record<string, unknown> = {}) => {
    const respond = vi.fn();
    const completed = invoke(method, { params, respond, context, client });
    return { respond, completed };
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const { respond, completed } = start(method, params);
    await completed;
    return respond;
  };
  return {
    context,
    events,
    call,
    start,
    open: async (params: Record<string, unknown> = {}, expected?: Record<string, unknown>) => {
      const sessionId: unknown = expectRespondOk(
        await call("talk.session.create", { mode: "transcription", ...params }),
        expected,
      ).sessionId;
      if (typeof sessionId !== "string") {
        throw new Error("Expected a transcription session ID");
      }
      return sessionId;
    },
    append: (sessionId: string, audio = Buffer.alloc(1600, 0xff)) =>
      call("talk.session.appendAudio", { sessionId, audioBase64: audio.toString("base64") }),
  };
}

function withFileProvider(
  run: (requests: AudioTranscriptionRequest[]) => Promise<void>,
  beforeTranscription?: () => Promise<void>,
  streamingProvider?: RealtimeTranscriptionProviderPlugin,
  audioProvider?: MediaUnderstandingProvider,
) {
  const requests: AudioTranscriptionRequest[] = [];
  const registry = createEmptyPluginRegistry();
  registry.mediaUnderstandingProviders.push({
    pluginId: "local-stt",
    source: "test",
    provider: audioProvider ?? {
      id: "local-stt",
      capabilities: ["audio"],
      transcribeAudio: async (request) => {
        requests.push(request);
        await beforeTranscription?.();
        return { text: "Turn the lights on", model: request.model };
      },
    },
  });
  if (streamingProvider) {
    registry.realtimeTranscriptionProviders.push({
      pluginId: "streaming-stt",
      source: "test",
      provider: streamingProvider,
    });
  }
  return withPluginRuntimeGenerationScope(
    {
      pluginRegistry: registry,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "local-stt", contracts: { mediaUnderstandingProviders: ["local-stt"] } },
          ...(streamingProvider
            ? [
                {
                  id: "streaming-stt",
                  contracts: { realtimeTranscriptionProviders: ["streaming-stt"] },
                },
              ]
            : []),
        ],
      }),
    },
    () => run(requests),
  );
}

describe("configured file transcription through Talk RPCs", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanupTalkConnection("conn-1", { warn: vi.fn() });
  });

  it.each([false, true])(
    "uses the selected conversation's audio credentials (default credentials: %s)",
    async (defaultHasCredentials) => {
      await withOpenClawTestState({ label: "talk-selected-audio-auth" }, async (state) => {
        const config: OpenClawConfig = {
          ...cfg,
          agents: {
            ownership: "explicit",
            entries: {
              main: {},
              researcher: { workspace: state.workspaceDir },
            },
          },
          talk: { agentId: "main" },
          models: {
            providers: {
              "local-stt": { baseUrl: "https://unused.invalid", models: [] },
            },
          },
        };
        await state.writeConfig(config);
        const lease = acquireStateDatabaseSchemaLease(resolveOpenClawStateSqlitePath(state.env));
        const maintenance = createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          assertOwnerCurrent: lease.assertCurrent,
          assertDatabaseAccess: lease.assertDatabaseAccess,
        });
        try {
          await maintenance.run(async () => {
            for (const agentId of ["main", "researcher"]) {
              await state.writeAuthProfiles(
                {
                  version: 1,
                  profiles:
                    agentId === "researcher" || defaultHasCredentials
                      ? {
                          "local-stt:audio": {
                            type: "api_key",
                            provider: "local-stt",
                            key: `synthetic-${agentId}-key`,
                          },
                        }
                      : {},
                },
                agentId,
              );
            }
          });
        } finally {
          await maintenance.close().finally(() => lease.release());
        }
        await withFileProvider(async (requests) => {
          const { open, append, call } = fileRpc(config, talkSessionHandlers, {
            connId: "conn-1",
            connect: { scopes: defaultHasCredentials ? ["operator.admin"] : [] },
          });
          const sessionId = await open({ sessionKey: "agent:researcher:main" });
          await append(sessionId);
          expectRespondOk(await call("talk.session.close", { sessionId }));
          expect(requests).toHaveLength(1);
          expect(requests[0]?.apiKey).toBe("synthetic-researcher-key");
        });
      });
    },
  );

  it.each([
    { configured: false, withHook: true },
    { configured: true, withHook: true },
    { configured: true, withHook: false },
  ])(
    "uses context-provider readiness without requiring a hook: %j",
    async ({ configured, withHook }) => {
      const contexts: AudioTranscriptionConfigContext[] = [];
      const config: OpenClawConfig = {
        ...cfg,
        tools: {
          media: {
            audio: { enabled: true, headers: { "x-source": "audio", "x-audio": "yes" } },
            models: [
              {
                provider: "local-stt",
                model: "whisper",
                capabilities: ["audio"],
                baseUrl: "https://speech.example/v1",
                headers: { "x-source": "entry" },
                profile: "local-stt:audio",
              },
            ],
          },
        },
      };
      await withFileProvider(
        async () => {
          const { call } = fileRpc(config, talkHandlers);
          expect(expectRespondOk(await call("talk.catalog"))).toMatchObject({
            transcription: {
              ready: configured,
              providers: [expect.objectContaining({ id: "local-stt", configured })],
            },
          });
          const created = await call("talk.session.create", { mode: "transcription" });
          if (configured) {
            expectRespondOk(created, { provider: "local-stt" });
          } else {
            expectRespondError(created, {
              message: expect.stringContaining("No configured audio transcription provider"),
            });
          }
          if (withHook) {
            expect(contexts[0]).toMatchObject({
              cfg: config,
              model: "whisper",
              profile: "local-stt:audio",
              baseUrl: "https://speech.example/v1",
              headers: { "x-source": "entry", "x-audio": "yes" },
            });
          }
        },
        undefined,
        undefined,
        {
          id: "local-stt",
          capabilities: ["audio"],
          transcribeAudioWithContext: async () => ({ ok: true, value: { text: "unused" } }),
          ...(withHook
            ? {
                isAudioConfigured: async (audioContext: AudioTranscriptionConfigContext) => {
                  contexts.push(audioContext);
                  return configured;
                },
              }
            : {}),
        },
      );
    },
  );

  it("transcribes captured browser audio with the configured media model", async () => {
    const transcribing = createDeferred();
    const release = createDeferred();
    onTestFinished(() => release.resolve());
    await withFileProvider(
      async (requests) => {
        const { call, open, append, start, events, context } = fileRpc(cfg, talkHandlers);
        const catalog = await call("talk.catalog");
        expectRespondOk(catalog, {
          transcription: {
            ready: true,
            activeProvider: "local-stt",
            providers: [
              {
                id: "local-stt",
                label: "local-stt",
                models: ["whisper"],
                configured: true,
                modes: ["transcription"],
                transports: ["gateway-relay"],
                brains: ["none"],
              },
            ],
          },
        });
        const sessionId = await open(
          { transport: "gateway-relay", brain: "none" },
          { provider: "local-stt", mode: "transcription" },
        );
        const capturedAudio = Buffer.alloc(1600, 0xff);
        capturedAudio.set([0x00, 0x80, 0x7f, 0xff, 0x10, 0x90]);
        for (const chunk of [
          capturedAudio.subarray(0, 1),
          capturedAudio.subarray(1, 4),
          capturedAudio.subarray(4),
        ]) {
          await append(sessionId, chunk);
        }
        expect(requests).toHaveLength(0);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { respond: closed, completed: closing } = start("talk.session.close", { sessionId });
        await awaitGateBeforeSettlement(
          transcribing.promise,
          closing,
          "close settled before transcription",
        );
        await vi.advanceTimersByTimeAsync(6000);
        expect(closed).not.toHaveBeenCalled();
        expect(events.some((event) => event.type === "close")).toBe(false);
        release.resolve();
        await closing;
        vi.useRealTimers();
        expectRespondOk(closed);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.model).toBe("whisper");
        // 8 kHz mono PCM16 WAV header, decoded samples, and silent remainder.
        expect(requests[0]?.buffer).toEqual(
          Buffer.concat([
            Buffer.from(
              "52494646a40c000057415645666d74201000000001000100401f0000803e00000200100064617461800c0000",
              "hex",
            ),
            Buffer.from("84827c7d0000000084c17c3e", "hex"),
            Buffer.alloc(3188),
          ]),
        );
        expect(events).toContainEqual(
          expect.objectContaining({ type: "transcript", text: "Turn the lights on" }),
        );
        expect(events.at(-1)?.type).toBe("close");
        cleanupTalkConnection("conn-1", context.logGateway);
      },
      async () => {
        transcribing.resolve();
        await release.promise;
      },
    );
  });

  it.each(["buffered", "finalizing"])(
    "discards %s audio through talk.session.close without publishing its transcript",
    async (phase) => {
      const entered = createDeferred();
      const release = createDeferred();
      await withFileProvider(
        async (requests) => {
          const { open, append, call, start, events } = fileRpc();
          const sessionId = await open();
          await append(sessionId);
          const closing =
            phase === "finalizing" ? start("talk.session.close", { sessionId }) : undefined;
          const finishing = closing?.completed;
          try {
            if (finishing) {
              await awaitGateBeforeSettlement(entered.promise, finishing, "STT did not start");
            }
            const discarded = await call("talk.session.close", { sessionId, discard: true });
            expectRespondOk(discarded, { ok: true });
            expect(requests).toHaveLength(finishing ? 1 : 0);
            if (finishing) {
              expect(requests[0]?.signal?.aborted).toBe(true);
            }
          } finally {
            release.resolve();
            await finishing;
          }
          if (closing) {
            expectRespondOk(closing.respond, { ok: true });
          }
          expect(events.filter((event) => event.text || event.type === "error")).toEqual([]);
          expect(events.filter((event) => event.type === "close")).toHaveLength(1);
        },
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
    },
  );

  it("enforces the largest audio fallback capture limit before dispatch", async () => {
    const models: MediaUnderstandingModelConfig[] = [
      { provider: "local-stt", model: "small", capabilities: ["audio"], maxBytes: 4096 },
      { provider: "local-stt", model: "large", capabilities: ["audio"], maxBytes: 16384 },
      { provider: "local-stt", model: "vision", capabilities: ["image"], maxBytes: 65536 },
    ];
    const maxBytes = 16384;
    await withFileProvider(async (requests) => {
      const config: OpenClawConfig = {
        ...cfg,
        tools: { media: { ...cfg.tools?.media, models } },
      };
      const { open, append, context } = fileRpc(config);
      const sessionId = await open();
      const accepted = await append(sessionId, Buffer.alloc((maxBytes - 44) / 2, 0xff));
      expectRespondOk(accepted);
      const rejected = await append(sessionId, Buffer.alloc(1, 0xff));
      expectRespondError(rejected, {
        message: expect.stringContaining(`${maxBytes} byte limit`),
      });
      expect(requests).toHaveLength(0);
      cleanupTalkConnection("conn-1", context.logGateway);
    });
  });

  it("preserves a saved transcription voice model when file models are also configured", async () => {
    const createSession = vi.fn(() => ({
      connect: async () => {},
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: () => true,
    }));
    await withFileProvider(
      async (requests) => {
        const config: OpenClawConfig = {
          ...cfg,
          agents: { defaults: { voiceModel: { primary: "streaming-stt/saved-model" } } },
        };
        const { call } = fileRpc(config, talkHandlers);
        const catalog = await call("talk.catalog");
        expect(expectRespondOk(catalog)).toMatchObject({
          transcription: { ready: true, activeProvider: "streaming-stt" },
        });
        const respond = await call("talk.session.create", { mode: "transcription" });
        expectRespondOk(respond, { provider: "streaming-stt" });
        expect(createSession).toHaveBeenCalledWith(
          expect.objectContaining({ providerConfig: { model: "saved-model" } }),
        );
        expect(requests).toHaveLength(0);
      },
      undefined,
      {
        id: "streaming-stt",
        label: "Streaming STT",
        models: ["saved-model"],
        isConfigured: () => true,
        createSession,
      },
    );
  });

  it.each(["unknown provider", "missing credentials", "missing CLI", "malformed CLI"])(
    "does not advertise or admit file transcription with %s",
    async (reason) => {
      await withFileProvider(async (requests) => {
        const config: OpenClawConfig = {
          ...cfg,
          models:
            reason === "missing credentials"
              ? { providers: { "local-stt": { baseUrl: "https://unused.invalid", models: [] } } }
              : cfg.models,
          tools: {
            media: {
              ...cfg.tools?.media,
              models:
                reason === "unknown provider"
                  ? [{ provider: "missing-stt", model: "whisper", capabilities: ["audio"] }]
                  : reason === "missing credentials"
                    ? cfg.tools?.media?.models
                    : [
                        {
                          type: "cli",
                          command:
                            reason === "missing CLI" ? "/missing/speech-command" : process.execPath,
                          args: reason === "missing CLI" ? ["{{AttachmentPath}}"] : [],
                          capabilities: ["audio"],
                        },
                      ],
            },
          },
        };
        const { call } = fileRpc(config, talkHandlers);
        const result = expectRespondOk(await call("talk.catalog"));
        expect(result).toMatchObject({ transcription: { ready: false } });
        expect(result).not.toHaveProperty("transcription.activeProvider");
        if (reason === "unknown provider" || reason === "missing credentials") {
          expect(result).toMatchObject({
            transcription: { providers: [expect.objectContaining({ configured: false })] },
          });
        }
        expectRespondError(await call("talk.session.create", { mode: "transcription" }), {
          message: expect.stringContaining("No configured audio transcription provider"),
        });
        expect(requests).toHaveLength(0);
      });
    },
  );

  it("advertises and uses a viable file fallback after an unknown provider", async () => {
    await withFileProvider(async (requests) => {
      const config: OpenClawConfig = {
        ...cfg,
        tools: {
          media: {
            ...cfg.tools?.media,
            models: [
              { provider: "missing-stt", model: "missing", capabilities: ["audio"] },
              { provider: "local-stt", model: "whisper", capabilities: ["audio"] },
            ],
          },
        },
      };
      const { open, append, call } = fileRpc(config, talkHandlers);
      const catalog = await call("talk.catalog");
      expect(expectRespondOk(catalog)).toMatchObject({
        transcription: {
          ready: true,
          activeProvider: "local-stt",
          providers: [
            expect.objectContaining({ id: "missing-stt", configured: false }),
            expect.objectContaining({ id: "local-stt", configured: true }),
          ],
        },
      });
      const sessionId = await open({}, { sessionId: expect.any(String) });
      await append(sessionId);
      const closed = await call("talk.session.close", { sessionId });
      expectRespondOk(closed);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.model).toBe("whisper");
    });
  });

  it.each([
    { name: "explicit provider", params: { provider: "streaming-only" }, streaming: false },
    { name: "explicit model", params: { model: "streaming-model" }, streaming: false },
    { name: "configured streaming", params: {}, streaming: true },
    { name: "no configured audio models", params: {}, streaming: false, unconfigured: true },
    { name: "image-only media models", params: {}, streaming: false, imageOnly: true },
  ])(
    "preserves $name selection instead of falling back to file audio",
    async ({ params, streaming, unconfigured, imageOnly }) => {
      await withFileProvider(async (requests) => {
        const config: OpenClawConfig = {
          ...(unconfigured ? {} : cfg),
          ...(imageOnly
            ? {
                agents: { ownership: "explicit", entries: { first: {}, second: {} } },
                tools: {
                  media: {
                    models: [{ provider: "local-stt", model: "vision", capabilities: ["image"] }],
                  },
                },
              }
            : {}),
          ...(streaming
            ? {
                plugins: {
                  entries: {
                    "voice-call": { config: { streaming: { provider: "streaming-only" } } },
                  },
                },
              }
            : {}),
        };
        const { call } = fileRpc(config);
        expectRespondError(
          await call("talk.session.create", { mode: "transcription", ...params }),
          {
            message: expect.stringContaining("transcription provider"),
          },
        );
        expect(requests).toHaveLength(0);
      });
    },
  );

  it("discards buffered audio when its connection closes before transcription starts", async () => {
    await withFileProvider(async (requests) => {
      const { open, append, call, context } = fileRpc();
      const sessionId = await open();
      await append(sessionId);
      const closing = call("talk.session.close", {
        sessionId,
      });
      cleanupTalkConnection("conn-1", context.logGateway);
      await closing;
      expect(requests).toHaveLength(0);
    });
  });

  it("reports provider failures as a Talk error before closing the session", async () => {
    await withFileProvider(
      async () => {
        const { open, append, call, events } = fileRpc();
        const sessionId = await open();
        await append(sessionId);
        const closed = await call("talk.session.close", { sessionId });
        expectRespondError(closed, {
          message: expect.stringContaining("Local speech endpoint rejected audio"),
        });
        expect(events.at(-2)).toMatchObject({
          type: "error",
          message: expect.stringContaining("Local speech endpoint rejected audio"),
        });
        expect(events.at(-1)?.type).toBe("close");
      },
      async () => {
        throw new Error("Local speech endpoint rejected audio");
      },
    );
  });
});
