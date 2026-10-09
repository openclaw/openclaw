import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, vi, type Mock } from "vitest";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import { testing as embeddedRunTesting } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { clientVoiceSessionTesting } from "../../../talk/client-voice-session.test-support.js";
import type {
  RealtimeVoiceAgentConsultRunner,
  RealtimeVoiceGatewayControl,
  RealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { sharingPolicyClient } from "../../session-sharing.test-utils.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import { drainingRelaySessions } from "../relay/state.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";

let state: OpenClawTestState;
export let config: OpenClawConfig;
export let client: ReturnType<typeof sharingPolicyClient> & { connId: string };
export let callback: RealtimeVoiceAgentConsultRunner | undefined;
export let providerInstructions: string | undefined;
export let providerScope: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
const browserVoiceSessionIds = new Set<string>();
export let browserControl: RealtimeVoiceGatewayControl | undefined;
export const submitProviderResult = vi.fn();
export const context = {
  getRuntimeConfig: () => config,
  resolveGatewayContext: () => context,
  getClientConnIds: () => new Set([client.connId]),
  chatAbortControllers: new Map(),
  broadcastToConnIds: vi.fn(),
  logGateway: { warn: vi.fn() },
} as unknown as GatewayRequestContext;

export async function dispatch(
  method: string,
  params: Record<string, unknown>,
  handlers: GatewayRequestHandlers = {},
  hasCurrentClientAuthority?: () => boolean,
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "native-consult", method, params },
    client,
    context,
    isWebchatConnect: () => false,
    respond,
    hasCurrentClientAuthority,
    extraHandlers: { ...talkClientHandlers, ...talkSessionHandlers, ...handlers },
  });
  const payload = respond.mock.calls.at(-1)?.[1];
  if (
    method === "talk.client.create" &&
    isRecord(payload) &&
    typeof payload.voiceSessionId === "string"
  ) {
    browserVoiceSessionIds.add(payload.voiceSessionId);
  }
  return respond;
}

export function setNativeConsultConfig(next: OpenClawConfig): void {
  config = next;
}

export function installNativeConsultTestHooks(mocks: {
  capabilities: RealtimeVoiceProviderCapabilities;
  resolveProvider: Mock;
  runEmbeddedAgent: Mock<
    (params: RunEmbeddedAgentParams) => Promise<{
      payloads: Array<{ text: string }>;
      meta: { durationMs: number };
    }>
  >;
}): void {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "talk-native-consult" });
    config = {
      agents: {
        ownership: "explicit",
        entries: { primary: {}, voice: { workspace: state.workspaceDir } },
      },
      talk: { agentId: "voice" },
    };
    client = {
      ...sharingPolicyClient({ user: ensureProfileForEmail("native-listener@example.test").id }),
      connId: "native-consult-client",
    };
    callback = undefined;
    providerInstructions = undefined;
    providerScope = undefined;
    browserVoiceSessionIds.clear();
    browserControl = undefined;
    vi.clearAllMocks();
    mocks.runEmbeddedAgent.mockReset().mockResolvedValue({
      payloads: [{ text: "Synthetic consult answer" }],
      meta: { durationMs: 0 },
    });
    context.chatAbortControllers.clear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const provider: RealtimeVoiceProviderPlugin = {
      id: "synthetic-voice",
      label: "Synthetic voice",
      capabilities: mocks.capabilities,
      isConfigured: () => true,
      createBrowserSession: async (request) => {
        providerScope = getPluginRuntimeGatewayRequestScope();
        providerInstructions = request.instructions;
        callback = request.runAgentConsult;
        browserControl = request.gatewayControl;
        browserControl?.bindBridge({
          connect: async () => undefined,
          sendAudio: () => undefined,
          setMediaTimestamp: () => undefined,
          handleBargeIn: () => undefined,
          submitToolResult: submitProviderResult,
          acknowledgeMark: () => undefined,
          close: () => undefined,
          isConnected: () => true,
        });
        return {
          provider: "synthetic-voice",
          transport: "webrtc",
          clientSecret: "synthetic-offer",
          offerUrl: "/test/offer",
        };
      },
      createBridge: (request) => {
        providerScope = getPluginRuntimeGatewayRequestScope();
        providerInstructions = request.instructions;
        callback = request.runAgentConsult;
        return {
          connect: async () => undefined,
          sendAudio: () => undefined,
          setMediaTimestamp: () => undefined,
          handleBargeIn: () => undefined,
          submitToolResult: () => undefined,
          acknowledgeMark: () => undefined,
          close: () => undefined,
          isConnected: () => true,
        };
      },
    };
    Object.defineProperty(provider, Symbol.for("openclaw.internal.realtime-voice-provider.v1"), {
      value: {
        isBrowserSessionConfigured: () => true,
        cancelBrowserSession: async () => undefined,
      },
    });
    mocks.resolveProvider.mockReturnValue({
      provider,
      providerConfig: {},
      capabilities: {
        ...mocks.capabilities,
        supportsGatewayControl: true,
        handlesAgentConsult: true,
      },
    });
  });

  afterEach(async () => {
    try {
      for (const browserVoiceSessionId of browserVoiceSessionIds) {
        await closeTalkClientGatewayControlSession({
          voiceSessionId: browserVoiceSessionId,
          sessionKey: "main",
          connId: client.connId,
        });
      }
      cleanupTalkConnection(client.connId, context.logGateway);
      await Promise.all(
        [...drainingRelaySessions].map(
          (session) =>
            session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
        ),
      );
    } finally {
      clientVoiceSessionTesting.reset();
      embeddedRunTesting.resetActiveEmbeddedRuns();
      setActivePluginRegistry(createEmptyPluginRegistry());
      await state.cleanup();
    }
  });
}
