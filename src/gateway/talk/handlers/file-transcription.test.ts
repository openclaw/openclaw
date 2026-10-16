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
import { expectRespondError, expectRespondOk } from "./responses.test-support.js";

const localProvider = { baseUrl: "https://unused.invalid", models: [] };
const cfg: OpenClawConfig = {
  models: {
    providers: {
      "local-stt": { ...localProvider, apiKey: "synthetic-fixture-key" },
    },
  },
  tools: {
    media: {
      audio: { enabled: true, maxBytes: 8192 },
      models: [{ provider: "local-stt", model: "whisper", capabilities: ["audio"] }],
    },
  },
};

function withAudioModels(
  models: MediaUnderstandingModelConfig[] | undefined,
  audio = cfg.tools?.media?.audio,
): OpenClawConfig {
  return { ...cfg, tools: { media: { audio, models } } };
}

function transcriptionFixture(config = cfg) {
  const events: Array<{ type?: string; text?: string; message?: string }> = [];
  const context = {
    getRuntimeConfig: () => config,
    broadcastToConnIds: (_event: string, payload: (typeof events)[number]) => events.push(payload),
    logGateway: { warn: vi.fn() },
  };
  const invoke = createTalkHandlerCaller(talkHandlers);
  const call = async (
    method: string,
    params: Record<string, unknown> = {},
    options: Omit<Partial<Parameters<typeof invoke>[1]>, "respond"> & {
      respond?: ReturnType<typeof vi.fn>;
    } = {},
  ) => {
    const respond = options.respond ?? vi.fn();
    await invoke(method, { params, context, ...options, respond });
    return respond;
  };
  return {
    call,
    context,
    events,
    create: async (params: Record<string, unknown> = {}) =>
      expectRespondOk(await call("talk.session.create", { mode: "transcription", ...params }))
        .sessionId,
    append: (sessionId: string, samples = 1600) =>
      call("talk.session.appendAudio", {
        sessionId,
        audioBase64: Buffer.alloc(samples, 0xff).toString("base64"),
      }),
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
  const metadata: NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]> = {
    plugins: [{ id: "local-stt", contracts: { mediaUnderstandingProviders: ["local-stt"] } }],
  };
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
    metadata.plugins.push({
      id: "streaming-stt",
      contracts: { realtimeTranscriptionProviders: ["streaming-stt"] },
    });
    registry.realtimeTranscriptionProviders.push({
      pluginId: "streaming-stt",
      source: "test",
      provider: streamingProvider,
    });
  }
  return withPluginRuntimeGenerationScope(
    {
      pluginRegistry: registry,
      metadataSnapshot: createPluginMetadataSnapshotFixture(metadata),
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
          models: { providers: { "local-stt": localProvider } },
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
          const { call, append } = transcriptionFixture(config);
          const created = await call(
            "talk.session.create",
            {
              mode: "transcription",
              sessionKey: "agent:researcher:main",
            },
            {
              client: {
                connId: "conn-1",
                connect: { scopes: defaultHasCredentials ? ["operator.admin"] : [] },
              },
            },
          );
          expect(created.mock.calls[0]?.[2]).toBeUndefined();
          const sessionId = (expectRespondOk(created) as { sessionId: string }).sessionId;
          await append(sessionId);
          expectRespondOk(await call("talk.session.close", { sessionId }));
          expect(requests).toMatchObject([{ apiKey: "synthetic-researcher-key" }]);
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
      const config = withAudioModels(
        [
          {
            provider: "local-stt",
            model: "whisper",
            capabilities: ["audio"],
            baseUrl: "https://speech.example/v1",
            headers: { "x-source": "entry" },
            profile: "local-stt:audio",
          },
        ],
        { enabled: true, headers: { "x-source": "audio", "x-audio": "yes" } },
      );
      const { call } = transcriptionFixture(config);
      await withFileProvider(
        async () => {
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
        const { call, append, events } = transcriptionFixture();
        expectRespondOk(await call("talk.catalog"), {
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
        const respond = await call("talk.session.create", {
          mode: "transcription",
          transport: "gateway-relay",
          brain: "none",
        });
        const session = expectRespondOk(respond, { provider: "local-stt", mode: "transcription" });
        const sessionId = (session as { sessionId: string }).sessionId;
        await append(sessionId);
        expect(requests).toHaveLength(0);
        const closed = vi.fn();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const closing = call("talk.session.close", { sessionId }, { respond: closed });
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
        expect(requests).toMatchObject([{ model: "whisper" }]);
        const audio = requests[0]?.buffer;
        expect(audio?.subarray(0, 4).toString()).toBe("RIFF");
        expect(audio?.readUInt32LE(24)).toBe(8000);
        expect(audio?.readUInt16LE(34)).toBe(16);
        expect(audio?.subarray(44)).toEqual(Buffer.alloc(3200));
        expect(events).toContainEqual(
          expect.objectContaining({ type: "transcript", text: "Turn the lights on" }),
        );
        expect(events.at(-1)?.type).toBe("close");
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
          const { call, create, append, events } = transcriptionFixture();
          const sessionId = await create();
          await append(sessionId);
          const finished = vi.fn();
          const finishing =
            phase === "finalizing"
              ? call("talk.session.close", { sessionId }, { respond: finished })
              : undefined;
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

  it("enforces the largest audio fallback capture limit before dispatch", async () => {
    const maxBytes = 16384;
    await withFileProvider(async (requests) => {
      const config = withAudioModels([
        { provider: "local-stt", model: "small", capabilities: ["audio"], maxBytes: 4096 },
        { provider: "local-stt", model: "large", capabilities: ["audio"], maxBytes },
        { provider: "local-stt", model: "vision", capabilities: ["image"], maxBytes: 65536 },
      ]);
      const { create, append } = transcriptionFixture(config);
      const sessionId = await create();
      expectRespondOk(await append(sessionId, (maxBytes - 44) / 2));
      expectRespondError(await append(sessionId, 1), {
        message: expect.stringContaining(`${maxBytes} byte limit`),
      });
      expect(requests).toHaveLength(0);
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
        const { call } = transcriptionFixture(config);
        expect(expectRespondOk(await call("talk.catalog"))).toMatchObject({
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
    (reason) =>
      withFileProvider(async (requests) => {
        const config: OpenClawConfig = {
          ...withAudioModels(
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
          ),
          models:
            reason === "missing credentials"
              ? { providers: { "local-stt": localProvider } }
              : cfg.models,
        };
        const { call } = transcriptionFixture(config);
        const result = expectRespondOk(await call("talk.catalog"));
        expect(result).toMatchObject({ transcription: { ready: false } });
        expect(result).not.toHaveProperty("transcription.activeProvider");
        if (reason === "unknown provider" || reason === "missing credentials") {
          expect(result).toMatchObject({
            transcription: { providers: [expect.objectContaining({ configured: false })] },
          });
        }
        const respond = await call("talk.session.create", { mode: "transcription" });
        expectRespondError(respond, {
          message: expect.stringContaining("No configured audio transcription provider"),
        });
        expect(requests).toHaveLength(0);
      }),
  );

  it("advertises and uses a viable file fallback after an unknown provider", () =>
    withFileProvider(async (requests) => {
      const config = withAudioModels([
        { provider: "missing-stt", model: "missing", capabilities: ["audio"] },
        { provider: "local-stt", model: "whisper", capabilities: ["audio"] },
      ]);
      const { call, create, append } = transcriptionFixture(config);
      expect(expectRespondOk(await call("talk.catalog"))).toMatchObject({
        transcription: {
          ready: true,
          activeProvider: "local-stt",
          providers: [
            expect.objectContaining({ id: "missing-stt", configured: false }),
            expect.objectContaining({ id: "local-stt", configured: true }),
          ],
        },
      });
      const sessionId = await create();
      expect(sessionId).toEqual(expect.any(String));
      await append(sessionId);
      expectRespondOk(await call("talk.session.close", { sessionId }));
      expect(requests).toMatchObject([{ model: "whisper" }]);
    }));

  it.each<{ name: string; config: OpenClawConfig; params?: Record<string, unknown> }>([
    { name: "explicit provider", params: { provider: "streaming-only" }, config: cfg },
    { name: "explicit model", params: { model: "streaming-model" }, config: cfg },
    {
      name: "configured streaming",
      config: {
        ...cfg,
        plugins: {
          entries: { "voice-call": { config: { streaming: { provider: "streaming-only" } } } },
        },
      },
    },
    { name: "no configured audio models", config: {} },
    {
      name: "image-only media models",
      config: {
        ...withAudioModels(
          [{ provider: "local-stt", model: "vision", capabilities: ["image"] }],
          {},
        ),
        agents: { ownership: "explicit", entries: { first: {}, second: {} } },
      },
    },
  ])("preserves $name selection instead of falling back to file audio", ({ params, config }) =>
    withFileProvider(async (requests) => {
      const responded = await transcriptionFixture(config).call("talk.session.create", {
        mode: "transcription",
        ...params,
      });
      expectRespondError(responded, {
        message: expect.stringContaining("transcription provider"),
      });
      expect(requests).toHaveLength(0);
    }),
  );

  it("discards buffered audio when its connection closes before transcription starts", () =>
    withFileProvider(async (requests) => {
      const { call, create, append, context } = transcriptionFixture();
      const sessionId = await create();
      await append(sessionId);
      const closing = call("talk.session.close", { sessionId });
      cleanupTalkConnection("conn-1", context.logGateway);
      await closing;
      expect(requests).toHaveLength(0);
    }));

  it("reports provider failures as a Talk error before closing the session", () =>
    withFileProvider(
      async () => {
        const { call, create, append, events } = transcriptionFixture();
        const sessionId = await create();
        await append(sessionId);
        expectRespondError(await call("talk.session.close", { sessionId }), {
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
    ));
});
