import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createMockIncomingRequest } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { createAttemptNestedToolActivityState } from "../../../agents/embedded-agent-runner/run/attempt-nested-tool-activity.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import * as embeddedRuns from "../../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../../agents/harness/tool-authority.runtime.js";
import type { AgentSession } from "../../../agents/sessions/agent-session.js";
import { AuthStorage } from "../../../agents/sessions/auth-storage.js";
import { setRuntimeConfigSnapshot } from "../../../config/io.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { TalkRealtimeConfig } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { resolveCapabilityProviderRegistration } from "../../../plugins/capability-catalog.js";
import { resolvePluginCapabilityCatalogContext } from "../../../plugins/loader-runtime-load.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { getCurrentSessionControllerOwner } from "../../../sessions/session-controller.lifecycle.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createChatRunState } from "../../server-chat-state.js";
import { createResponse } from "../../server-http.test-harness.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../server-methods/types.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { withRegisteredNativeEmbeddedRun } from "./client-native-run.test-support.js";
import { talkClientHandlers } from "./client.js";

const nativeUpstream = await vi.hoisted(async () => {
  const { createNativeSocketFixture } = await import("./client-native-socket.test-support.js");
  const { NativeSocket, sockets, events } = createNativeSocketFixture();
  const oauthToken = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "native-test" } }),
    ).toString("base64url"),
    "synthetic-signature",
  ].join(".");
  return {
    NativeSocket,
    sockets,
    events,
    fetch: vi.fn<typeof fetch>(),
    runEmbeddedAgent: vi.fn<typeof import("../../../agents/embedded-agent.js").runEmbeddedAgent>(),
    authConfigured: vi.fn(
      ({ profileTypes }: { profileTypes?: readonly string[] }) =>
        profileTypes?.includes("oauth") === true,
    ),
    resolveAuth: vi.fn(async ({ profileTypes }: { profileTypes?: readonly string[] }) =>
      profileTypes?.includes("oauth") ? oauthToken : undefined,
    ),
  };
});

vi.mock("../../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: nativeUpstream.runEmbeddedAgent,
}));
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/websocket-runtime")>()),
  WebSocket: nativeUpstream.NativeSocket,
}));
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  isProviderAuthProfileConfigured: nativeUpstream.authConfigured,
  resolveProviderAuthProfileApiKey: nativeUpstream.resolveAuth,
}));

export const upstream = nativeUpstream;

const { default: openaiPlugin } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({ pluginId: "openai", artifactBasename: "index.js" });

type PluginApi = ReturnType<typeof createTestPluginApi>;
type HttpRoute = Parameters<PluginApi["registerHttpRoute"]>[0];
type PluginLifecycle = Parameters<PluginApi["registerRuntimeLifecycle"]>[0];
export const AGENT_ID = "voice";
export const SESSION_KEY = "agent:voice:main";
export const SESSION_ID = "native-control-transcript";
export const CONNECTION_ID = "native-control-client";
export const nativeSessionScope = { agentId: AGENT_ID, sessionKey: SESSION_KEY };
const AUDIO_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const DATA_CHANNEL_SDP = `${AUDIO_SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`;

export function nativeResult(text: string, meta: { aborted?: boolean } = {}) {
  return { payloads: [{ text }], meta: { durationMs: 0, ...meta } };
}

export function nativeConsult(text: string) {
  return (params: RunEmbeddedAgentParams) =>
    withRegisteredNativeEmbeddedRun(params, () => nativeResult(text));
}

export async function settleNativeBackend(release: () => void) {
  release();
  await Promise.allSettled(
    upstream.runEmbeddedAgent.mock.results
      .filter((result) => result.type === "return")
      .map((result) => result.value),
  );
  // Join the consult owner's continuations before another delegation can supersede its signal.
  await nextEventLoopTurn();
}

export function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Expected nonempty ${key}`);
  }
  return value;
}

function requireSuccessfulReply([ok, payload, error]: Parameters<RespondFn>) {
  // Report the public rejection, never the credential-bearing session payload.
  expect({ ok, error }).toEqual({ ok: true, error: undefined });
  if (!isRecord(payload)) {
    throw new Error("Expected a Talk result object");
  }
  return payload;
}

type NativePluginFixture = {
  create: (negotiated: boolean, voiceSessionId?: string) => Promise<Record<string, unknown>>;
  invoke: (
    method: keyof typeof talkClientHandlers,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  invokeResponse: (
    method: keyof typeof talkClientHandlers,
    params: Record<string, unknown>,
  ) => Promise<Parameters<RespondFn>>;
  offer: (
    token: string,
    sdp: string,
  ) => {
    handling: Promise<boolean | void>;
    response: ReturnType<typeof createResponse>;
  };
  broadcast: ReturnType<typeof vi.fn>;
  rpcSourceTesting: typeof rpcSourceTesting;
};

export async function withNativePlugin(
  run: (fixture: NativePluginFixture) => Promise<void>,
  options: {
    model?: string;
    nativeEffects?: boolean;
    onConsult?: () => void;
    configure?: (config: OpenClawConfig) => void;
  } = {},
): Promise<void> {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "talk-native-control-", env: { OPENAI_API_KEY: undefined } },
    async (state) => {
      const realtimeConfig: TalkRealtimeConfig = {
        provider: "openai",
        providers: { openai: { apiKey: "test-key" } },
        transport: "webrtc",
      };
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            voice: { agentDir: state.agentDir(AGENT_ID), workspace: state.workspaceDir },
            other: {},
          },
        },
        ...(options.nativeEffects ? { tools: { exec: { host: "gateway", mode: "full" } } } : {}),
        talk: { agentId: AGENT_ID, realtime: realtimeConfig },
        plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      };
      options.configure?.(config);
      setRuntimeConfigSnapshot(config);
      const registry = createEmptyPluginRegistry();
      // Native factory binding must retain the fixture's synthetic auth, not resolve operator credentials.
      const capabilityCatalogContext = {
        ...resolvePluginCapabilityCatalogContext(),
        isProviderAuthProfileConfigured: nativeUpstream.authConfigured,
        resolveProviderAuthProfileApiKey: nativeUpstream.resolveAuth,
      };
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const routes: HttpRoute[] = [];
      const lifecycles: PluginLifecycle[] = [];
      const broadcast = vi.fn();
      const profile = ensureProfileForEmail("native-control@example.test");
      const client = {
        ...sharingPolicyClient({
          user: profile.id,
          scopes: [
            "operator.read",
            "operator.talk",
            ...(options.nativeEffects ? ["operator.write"] : []),
          ],
        }),
        connId: CONNECTION_ID,
      };
      const context = {
        getRuntimeConfig: () => config,
        getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
          new Set(!filter || filter(client) ? [CONNECTION_ID] : []),
        broadcastToConnIds: broadcast,
        logGateway: { warn: vi.fn() },
        chatRunState: createChatRunState(),
        removeChatRun: vi.fn(),
        agentRunSeq: new Map(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
      } as unknown as GatewayRequestContext;
      const voiceSessionIds: string[] = [];
      try {
        if (!openaiPlugin.register) {
          throw new Error("OpenAI did not expose its public registration entry");
        }
        openaiPlugin.register(
          createTestPluginApi({
            id: "openai",
            registrationMode: "full",
            config,
            runtime: createPluginRuntimeMock({ config: { current: () => config } }),
            registerProvider: (provider) =>
              registry.providers.push({ pluginId: "openai", source: "test", provider }),
            registerRealtimeVoiceProvider: (entry) => {
              const provider = resolveCapabilityProviderRegistration(
                entry,
                () => capabilityCatalogContext,
              );
              const createBrowserSession = provider.createBrowserSession;
              if (createBrowserSession && options.onConsult) {
                provider.createBrowserSession = (request) => {
                  const original = request.runAgentConsult;
                  if (original) {
                    request.runAgentConsult = Object.assign(
                      (...args: Parameters<typeof original>) => {
                        options.onConsult?.();
                        return original(...args);
                      },
                      original,
                    );
                  }
                  return createBrowserSession(request);
                };
              }
              registry.realtimeVoiceProviders.push({
                pluginId: "openai",
                source: "test",
                provider,
              });
            },
            registerHttpRoute: (route) => routes.push(route),
            registerRuntimeLifecycle: (lifecycle) => lifecycles.push(lifecycle),
          }),
        );
        realtimeConfig.model = options.model ?? "gpt-live-test-canary";
        setActivePluginRegistry(registry);
        const offerRoute = routes.find((route) => route.path === "/plugins/openai/realtime/calls");
        if (!offerRoute) {
          throw new Error("OpenAI did not register its realtime offer route");
        }
        await replaceSessionEntry(nativeSessionScope, {
          sessionId: SESSION_ID,
          ...(options.nativeEffects ? { permissionMode: "full", execHost: "gateway" } : {}),
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: profile.id },
        });
        const call = async (
          method: keyof typeof talkClientHandlers,
          params: Record<string, unknown>,
        ) => {
          const respond = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: { type: "req", id: "native-control-request", method, params },
            respond,
            context,
            client,
            isWebchatConnect: () => false,
            extraHandlers: talkClientHandlers,
          });
          return expectDefined(respond.mock.calls.at(-1), "Talk handler did not respond");
        };
        const invokeResponse: NativePluginFixture["invokeResponse"] = (method, params) =>
          call(method, {
            sessionKey: SESSION_KEY,
            ...(method === "talk.client.steer" ? {} : { voiceSessionId: voiceSessionIds.at(-1) }),
            ...params,
          });
        await run({
          create: async (negotiated, voiceSessionId) => {
            const result = requireSuccessfulReply(
              await call("talk.client.create", {
                sessionKey: SESSION_KEY,
                mode: "realtime",
                transport: "webrtc",
                brain: "agent-consult",
                silenceDurationMs: 400,
                capabilities: negotiated ? ["gateway-control-v1"] : ["voice-transcript"],
                ...(voiceSessionId ? { voiceSessionId } : {}),
              }),
            );
            voiceSessionIds.push(requireString(result, "voiceSessionId"));
            return result;
          },
          invoke: async (method, params) =>
            requireSuccessfulReply(await invokeResponse(method, params)),
          invokeResponse,
          offer: (token, sdp) => {
            const request = Object.assign(createMockIncomingRequest([sdp]), {
              method: "POST",
              url: offerRoute.path,
              headers: { authorization: `Bearer ${token}`, "content-type": "application/sdp" },
            });
            const response = createResponse();
            const handling = Promise.resolve(offerRoute.handler(request, response.res));
            return { handling, response };
          },
          broadcast,
          rpcSourceTesting,
        });
      } finally {
        for (const voiceSessionId of voiceSessionIds) {
          await closeTalkClientGatewayControlSession({
            voiceSessionId,
            sessionKey: SESSION_KEY,
            connId: CONNECTION_ID,
          });
        }
        cleanupTalkConnection(CONNECTION_ID, context.logGateway);
        for (const lifecycle of lifecycles) {
          await lifecycle.cleanup?.({ reason: "disable" });
        }
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    },
  );
}

export async function connectNativeSession(
  { create, offer }: Pick<NativePluginFixture, "create" | "offer">,
  negotiated = true,
  voiceSessionId?: string,
) {
  const socketIndex = upstream.sockets.length;
  const result = await create(negotiated, voiceSessionId);
  expect(result.clientControl).toEqual(negotiated ? { owner: "gateway" } : undefined);
  const sdp = negotiated ? AUDIO_SDP : DATA_CHANNEL_SDP;
  const socketCreated = createDeferredCore();
  upstream.events.once("socket", socketCreated.resolve);
  try {
    const { handling, response } = offer(requireString(result, "clientSecret"), sdp);
    await Promise.race([
      socketCreated.promise,
      handling.then(() => {
        throw new Error(
          `Native offer completed before sideband readiness (HTTP ${response.res.statusCode})`,
        );
      }),
    ]);
    expect(response.end).not.toHaveBeenCalled();
    const socket = expectDefined(upstream.sockets[socketIndex], "Missing native sideband");
    socket.open();
    await handling;
    expect(response.res.statusCode).toBe(200);
    return { result, socket };
  } finally {
    upstream.events.removeListener("socket", socketCreated.resolve);
  }
}

export function nativeDelegation(id: string, text: string) {
  return {
    type: "delegation.created",
    item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
  };
}

export function talkEventTypes(broadcast: ReturnType<typeof vi.fn>): string[] {
  return broadcast.mock.calls.flatMap(([event, payload]) => {
    if (event !== "talk.event" || !isRecord(payload) || !isRecord(payload.talkEvent)) {
      return [];
    }
    return typeof payload.talkEvent.type === "string" ? [payload.talkEvent.type] : [];
  });
}

type ConnectedNativePluginFixture = NativePluginFixture &
  Awaited<ReturnType<typeof connectNativeSession>>;

type ParkedNativeTask = ConnectedNativePluginFixture & {
  activeRun: RunEmbeddedAgentParams & { abortSignal: AbortSignal };
  abortOwned: ReturnType<typeof vi.fn<() => void>>;
  queueMessage: ReturnType<
    typeof vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>
  >;
  settleBackend: () => Promise<void>;
};

export async function withParkedNativeTask(
  run: (task: ParkedNativeTask) => Promise<void>,
  prompt = "Keep working until I cancel.",
  ...embedded:
    | []
    | [session: AgentSession, finish: () => void, prepared?: ConnectedNativePluginFixture]
): Promise<void> {
  const [embeddedSession, finishEmbeddedSession, preparedFixture] = embedded;
  const releaseBackend = createDeferredCore();
  const registered =
    createDeferredCore<
      Awaited<ReturnType<typeof embeddedRuns.prepareEmbeddedAgentRunCompletionClaim>["registered"]>
    >();
  const failed = createDeferredCore<never>();
  const runAbortController = new AbortController();
  let activeRun: RunEmbeddedAgentParams | undefined;
  let phase = "waiting for delegation";
  let backendAborted = false;
  const abortOwned = vi.fn(() => {
    backendAborted = true;
    runAbortController.abort();
    void embeddedSession?.abort();
    releaseBackend.resolve();
  });
  const queueMessage = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
    async () => undefined,
  );
  upstream.runEmbeddedAgent
    .mockImplementationOnce(async (params) => {
      try {
        phase = "admitting backend";
        if (!params.preparedRunAdmission) {
          throw new Error("Expected real Talk admission");
        }
        const admittedRunContext = await params.preparedRunAdmission.admit(
          "embedded",
          "native-test-backend",
        );
        phase = "preparing tool authority";
        return await withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext },
          {
            ...params,
            provider: "test-provider",
            modelId: "test-model",
            sessionFile: "/tmp/native-control-test-session.jsonl",
          },
          undefined,
          async (prepared) => {
            let stream:
              | ReturnType<
                  typeof import("../../../agents/embedded-agent-runner/run/attempt-stream-prepare.js").prepareEmbeddedAttemptStream
                >
              | undefined;
            if (embeddedSession) {
              phase = "loading embedded stream";
              const { prepareEmbeddedAttemptStream } =
                await import("../../../agents/embedded-agent-runner/run/attempt-stream-prepare.js");
              const model = expectDefined(embeddedSession.model, "Expected an embedded test model");
              phase = "publishing embedded registration";
              stream = prepareEmbeddedAttemptStream({
                attempt: {
                  ...prepared,
                  admittedRunContext,
                  model,
                  modelRegistry: embeddedSession.modelRegistry,
                  authStorage: AuthStorage.inMemory(),
                  authProfileStore: { version: 1, profiles: {} },
                  thinkLevel: "off",
                  fastMode: undefined,
                },
                agentSession: {
                  activeSession: embeddedSession,
                  hookRunner: null,
                  clientToolCallSlots: [],
                  hasDeliveredSourceReply: () => false,
                  markSourceReplyDelivered: () => {},
                  builtinToolNames: new Set(),
                  sourceReplyCapableToolNames: new Set(),
                  coreBuiltinToolNames: new Set(),
                  replaySafeToolNames: new Set(),
                  codeModeExecToolNames: new Set(),
                  sideEffectToolOwners: new Map(),
                  trustedLocalMediaToolNames: new Set(),
                },
                hookAgentId: AGENT_ID,
                diagnosticTrace: createDiagnosticTraceContext(),
                diagnosticOwner: createDiagnosticEmbeddedRunOwner({
                  sessionId: params.sessionId,
                  runId: params.runId,
                }),
                nestedToolActivityState: createAttemptNestedToolActivityState(),
                isReplaySafeTool: () => false,
                runAbortController,
                abortRun: abortOwned,
                markExternalAbort: () => {},
                getRunState: () => ({
                  aborted: backendAborted,
                  promptError: undefined,
                  timedOut: false,
                  yieldDetected: false,
                }),
                onBlockReply: undefined,
                onBlockReplyFlush: undefined,
              });
            }
            const handle =
              stream?.queueHandle ??
              createEmbeddedRunHandle({
                runId: params.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
                abort: abortOwned,
                queueMessage,
              });
            const releaseOnAbort = () => releaseBackend.resolve();
            if (!stream) {
              handle.messageInjectionV2 = {
                version: 2,
                isAvailable: () => !backendAborted,
                queueMessage: async (text, options, assertCurrent) => {
                  assertCurrent();
                  return await queueMessage(text, options);
                },
              };
              phase = "publishing embedded registration";
              embeddedRuns.attachActiveEmbeddedRun(
                params.sessionId,
                handle,
                params.sessionKey,
                prepared.sessionFile,
                params.agentId,
                params.replyOperation ?? getCurrentSessionControllerOwner(),
              );
            }
            activeRun = params;
            params.abortSignal?.addEventListener("abort", releaseOnAbort, { once: true });
            try {
              phase = "running embedded prompt";
              await embeddedSession?.prompt(params.prompt);
              phase = "waiting for backend release";
              await releaseBackend.promise;
              return nativeResult("Original task completed normally.", {
                aborted: backendAborted || params.abortSignal?.aborted === true,
              });
            } finally {
              params.abortSignal?.removeEventListener("abort", releaseOnAbort);
              stream?.subscription.unsubscribe();
              embeddedRuns.detachActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
            }
          },
        );
      } catch (error) {
        failed.reject(error);
        throw error;
      }
    })
    .mockImplementation(nativeConsult("Subsequent task completed."));
  const settleBackend = () => settleNativeBackend(releaseBackend.resolve);
  const runInFixture = async (fixture: NativePluginFixture) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let stopObservingCompletion: (() => void) | undefined;
    const timeoutMs = 1000;
    const prepare = embeddedRuns.prepareEmbeddedAgentRunCompletionClaim;
    const observeRegistration = vi
      .spyOn(embeddedRuns, "prepareEmbeddedAgentRunCompletionClaim")
      .mockImplementation((sessionId, runId, target) => {
        const claim = prepare(sessionId, runId, target);
        if (sessionId === SESSION_ID && deadline === undefined) {
          // Workspace and session preparation precede the registration owner's lifetime.
          phase = "waiting for embedded registration";
          deadline = setTimeout(() => {
            failed.reject(
              new Error(
                `registration readiness not observed within ${timeoutMs} ms; last phase: ${phase}`,
              ),
            );
          }, timeoutMs);
          registered.resolve(claim.registered);
        }
        return claim;
      });
    try {
      const session = preparedFixture ?? (await connectNativeSession(fixture));
      const readiness = Promise.race([registered.promise, failed.promise]);
      const send = session.socket.send.bind(session.socket);
      const observeCompletion = vi.spyOn(session.socket, "send").mockImplementation((payload) => {
        send(payload);
        const event: unknown = JSON.parse(payload);
        if (
          isRecord(event) &&
          event.type === "delegation.context.append" &&
          event.delegation_item_id === "original-task"
        ) {
          failed.reject(new Error("Native delegation completed before backend registration"));
        }
      });
      stopObservingCompletion = () => observeCompletion.mockRestore();
      session.socket.serverEvent(nativeDelegation("original-task", prompt));
      const registration = await readiness;
      stopObservingCompletion();
      stopObservingCompletion = undefined;
      clearTimeout(deadline);
      if (!registration) {
        throw new Error(`registration closed before readiness; last phase: ${phase}`);
      }
      if (!activeRun?.abortSignal) {
        throw new Error("Native delegation did not admit a cancellable model run");
      }
      // Prove the parked backend's real control owner is ready before testing event order.
      // This read-only RPC also keeps cold runtime loading out of negative action assertions.
      expect(
        await fixture.invoke("talk.client.steer", { text: "Status?", mode: "status" }),
      ).toMatchObject({ active: true, sessionId: activeRun.sessionId });
      await run({
        ...fixture,
        ...session,
        activeRun: { ...activeRun, abortSignal: activeRun.abortSignal },
        abortOwned,
        queueMessage,
        settleBackend,
      });
    } finally {
      stopObservingCompletion?.();
      clearTimeout(deadline);
      // Setup can fail before the callback that would otherwise release this stream.
      try {
        finishEmbeddedSession?.();
      } finally {
        try {
          await settleBackend();
        } finally {
          observeRegistration.mockRestore();
        }
      }
    }
  };
  if (preparedFixture) {
    await runInFixture(preparedFixture);
  } else {
    await withNativePlugin(runInFixture);
  }
}

export function installNativePluginTestHooks() {
  beforeEach(() => {
    upstream.sockets.length = 0;
    upstream.fetch.mockReset();
    upstream.fetch.mockImplementation(
      async () =>
        new Response("v=native-answer\r\n", {
          status: 201,
          headers: { Location: `/v1/live/rtc_native_test_${upstream.fetch.mock.calls.length}` },
        }),
    );
    vi.stubGlobal("fetch", upstream.fetch);
    upstream.authConfigured.mockClear();
    upstream.resolveAuth.mockClear();
    upstream.runEmbeddedAgent
      .mockReset()
      .mockRejectedValue(new Error("Unexpected model invocation"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}
