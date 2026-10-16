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
import { cleanupTalkConnection } from "../session-registry.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { talkHandlers } from "./index.js";
import {
  expectRecordFields,
  expectRespondError,
  expectRespondOk,
} from "./responses.test-support.js";
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
          const call = createTalkHandlerCaller(talkSessionHandlers);
          const context = {
            getRuntimeConfig: () => config,
            broadcastToConnIds: vi.fn(),
            logGateway: { warn: vi.fn() },
          };
          const created = vi.fn();
          await call("talk.session.create", {
            params: { mode: "transcription", sessionKey: "agent:researcher:main" },
            client: {
              connId: "conn-1",
              connect: { scopes: defaultHasCredentials ? ["operator.admin"] : [] },
            },
            context,
            respond: created,
          });
          expect(created.mock.calls[0]?.[2]).toBeUndefined();
          const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
          await call("talk.session.appendAudio", {
            params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
            context,
            respond: vi.fn(),
          });
          const closed = vi.fn();
          await call("talk.session.close", { params: { sessionId }, context, respond: closed });
          expectRespondOk(closed);
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
      const context = {
        getRuntimeConfig: () => config,
        broadcastToConnIds: vi.fn(),
        logGateway: { warn: vi.fn() },
      };
      await withFileProvider(
        async () => {
          const call = createTalkHandlerCaller(talkHandlers);
          const respond = vi.fn();
          await call("talk.catalog", { params: {}, context, respond });
          expect(expectRespondOk(respond)).toMatchObject({
            transcription: {
              ready: configured,
              providers: [expect.objectContaining({ id: "local-stt", configured })],
            },
          });
          const created = vi.fn();
          await call("talk.session.create", {
            params: { mode: "transcription" },
            context,
            respond: created,
          });
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
        const call = createTalkHandlerCaller(talkHandlers);
        const events: Array<{ type?: string; text?: string }> = [];
        const context = {
          getRuntimeConfig: () => cfg,
          broadcastToConnIds: (_event: string, payload: { type?: string; text?: string }) =>
            events.push(payload),
          logGateway: { warn: vi.fn() },
        };
        const catalog = vi.fn();
        await call("talk.catalog", { params: {}, respond: catalog, context });
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
        const respond = vi.fn();
        await call("talk.session.create", {
          params: { mode: "transcription", transport: "gateway-relay", brain: "none" },
          respond,
          context,
        });
        const session = expectRespondOk(respond, { provider: "local-stt", mode: "transcription" });
        const sessionId = (session as { sessionId: string }).sessionId;
        await call("talk.session.appendAudio", {
          params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
          respond: vi.fn(),
          context,
        });
        expect(requests).toHaveLength(0);
        const closed = vi.fn();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const closing = call("talk.session.close", {
          params: { sessionId },
          respond: closed,
          context,
        });
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
        const audio = requests[0]?.buffer;
        expect(audio?.subarray(0, 4).toString()).toBe("RIFF");
        expect(audio?.readUInt32LE(24)).toBe(8000);
        expect(audio?.readUInt16LE(34)).toBe(16);
        expect(audio?.subarray(44)).toEqual(Buffer.alloc(3200));
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
          const events: Array<{ type?: string; text?: string }> = [];
          const context = {
            getRuntimeConfig: () => cfg,
            broadcastToConnIds: (_event: string, payload: { type?: string; text?: string }) =>
              events.push(payload),
            logGateway: { warn: vi.fn() },
          };
          const call = createTalkHandlerCaller(talkSessionHandlers);
          const created = vi.fn();
          await call("talk.session.create", {
            params: { mode: "transcription" },
            respond: created,
            context,
          });
          const sessionId = expectRespondOk(created).sessionId;
          await call("talk.session.appendAudio", {
            params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
            respond: vi.fn(),
            context,
          });
          const finished = vi.fn();
          const finishing =
            phase === "finalizing"
              ? call("talk.session.close", { params: { sessionId }, respond: finished, context })
              : undefined;
          try {
            if (finishing) {
              await awaitGateBeforeSettlement(entered.promise, finishing, "STT did not start");
            }
            const discarded = vi.fn();
            await call("talk.session.close", {
              params: { sessionId, discard: true },
              respond: discarded,
              context,
            });
            expectRespondOk(discarded, { ok: true });
            expect(requests).toHaveLength(finishing ? 1 : 0);
            if (finishing) {
              expect(requests[0]?.signal?.aborted).toBe(true);
            }
          } finally {
            release.resolve();
            await finishing;
          }
          if (finishing) {
            expectRespondOk(finished, { ok: true });
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

  it.each([
    { name: "audio default", models: cfg.tools?.media?.models, maxBytes: 8192 },
    {
      name: "largest audio fallback",
      models: [
        { provider: "local-stt", model: "small", capabilities: ["audio"], maxBytes: 4096 },
        { provider: "local-stt", model: "large", capabilities: ["audio"], maxBytes: 16384 },
        { provider: "local-stt", model: "vision", capabilities: ["image"], maxBytes: 65536 },
      ],
      maxBytes: 16384,
    },
  ] satisfies Array<{
    name: string;
    models: MediaUnderstandingModelConfig[] | undefined;
    maxBytes: number;
  }>)("enforces the $name capture limit before dispatch", async ({ models, maxBytes }) => {
    await withFileProvider(async (requests) => {
      const call = createTalkHandlerCaller(talkSessionHandlers);
      const config: OpenClawConfig = {
        ...cfg,
        tools: { media: { ...cfg.tools?.media, models } },
      };
      const context = {
        getRuntimeConfig: () => config,
        broadcastToConnIds: vi.fn(),
        logGateway: { warn: vi.fn() },
      };
      const created = vi.fn();
      await call("talk.session.create", {
        params: { mode: "transcription" },
        respond: created,
        context,
      });
      const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
      const accepted = vi.fn();
      await call("talk.session.appendAudio", {
        params: {
          sessionId,
          audioBase64: Buffer.alloc((maxBytes - 44) / 2, 0xff).toString("base64"),
        },
        respond: accepted,
        context,
      });
      expectRespondOk(accepted);
      const rejected = vi.fn();
      await call("talk.session.appendAudio", {
        params: { sessionId, audioBase64: Buffer.alloc(1, 0xff).toString("base64") },
        respond: rejected,
        context,
      });
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
        const context = {
          getRuntimeConfig: () => config,
          broadcastToConnIds: vi.fn(),
          logGateway: { warn: vi.fn() },
        };
        const call = createTalkHandlerCaller(talkHandlers);
        const catalog = vi.fn();
        await call("talk.catalog", { params: {}, context, respond: catalog });
        expect(expectRespondOk(catalog)).toMatchObject({
          transcription: { ready: true, activeProvider: "streaming-stt" },
        });
        const respond = vi.fn();
        await call("talk.session.create", {
          params: { mode: "transcription" },
          context,
          respond,
        });
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
        const call = createTalkHandlerCaller(talkHandlers);
        const catalog = vi.fn();
        await call("talk.catalog", { params: {}, config, respond: catalog });
        const result = expectRespondOk(catalog);
        expect(result).toMatchObject({ transcription: { ready: false } });
        expect(result).not.toHaveProperty("transcription.activeProvider");
        if (reason === "unknown provider" || reason === "missing credentials") {
          expect(result).toMatchObject({
            transcription: { providers: [expect.objectContaining({ configured: false })] },
          });
        }
        const respond = vi.fn();
        await call("talk.session.create", {
          params: { mode: "transcription" },
          config,
          respond,
        });
        expectRespondError(respond, {
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
      const context = {
        getRuntimeConfig: () => config,
        broadcastToConnIds: vi.fn(),
        logGateway: { warn: vi.fn() },
      };
      const call = createTalkHandlerCaller(talkHandlers);
      const catalog = vi.fn();
      await call("talk.catalog", { params: {}, context, respond: catalog });
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
      const created = vi.fn();
      await call("talk.session.create", {
        params: { mode: "transcription" },
        context,
        respond: created,
      });
      const sessionId = expectRecordFields(expectRespondOk(created), {
        sessionId: expect.any(String),
      }).sessionId;
      await call("talk.session.appendAudio", {
        params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
        respond: vi.fn(),
        context,
      });
      const closed = vi.fn();
      await call("talk.session.close", { params: { sessionId }, context, respond: closed });
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
        const responded = vi.fn();
        await createTalkHandlerCaller(talkSessionHandlers)("talk.session.create", {
          params: { mode: "transcription", ...params },
          respond: responded,
          config,
        });
        expectRespondError(responded, {
          message: expect.stringContaining("transcription provider"),
        });
        expect(requests).toHaveLength(0);
      });
    },
  );

  it("discards buffered audio when its connection closes before transcription starts", async () => {
    await withFileProvider(async (requests) => {
      const call = createTalkHandlerCaller(talkSessionHandlers);
      const context = {
        getRuntimeConfig: () => cfg,
        broadcastToConnIds: vi.fn(),
        logGateway: { warn: vi.fn() },
      };
      const created = vi.fn();
      await call("talk.session.create", {
        params: { mode: "transcription" },
        respond: created,
        context,
      });
      const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
      await call("talk.session.appendAudio", {
        params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
        respond: vi.fn(),
        context,
      });
      const closing = call("talk.session.close", {
        params: { sessionId },
        respond: vi.fn(),
        context,
      });
      cleanupTalkConnection("conn-1", context.logGateway);
      await closing;
      expect(requests).toHaveLength(0);
    });
  });

  it("reports provider failures as a Talk error before closing the session", async () => {
    await withFileProvider(
      async () => {
        const call = createTalkHandlerCaller(talkSessionHandlers);
        const events: Array<{ type?: string; message?: string }> = [];
        const context = {
          getRuntimeConfig: () => cfg,
          broadcastToConnIds: (_event: string, payload: { type?: string; message?: string }) =>
            events.push(payload),
          logGateway: { warn: vi.fn() },
        };
        const created = vi.fn();
        await call("talk.session.create", {
          params: { mode: "transcription" },
          respond: created,
          context,
        });
        const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
        await call("talk.session.appendAudio", {
          params: { sessionId, audioBase64: Buffer.alloc(1600, 0xff).toString("base64") },
          respond: vi.fn(),
          context,
        });
        const closed = vi.fn();
        await call("talk.session.close", { params: { sessionId }, respond: closed, context });
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
