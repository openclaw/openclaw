// Shared relay test doubles for the talk realtime gateway relay suites.
import { vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { resolveRealtimeVoiceProviderCapabilities } from "../../../talk/provider-resolver.js";
import type { RealtimeVoiceBridge } from "../../../talk/provider-types.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { stopTalkRealtimeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession as createTalkRealtimeRelaySessionRaw } from "./session-create.js";
import { drainingRelaySessions } from "./state.js";

export function makeRelayTransport<
  Overrides extends Partial<RealtimeVoiceBridge> = Record<never, never>,
>(overrides: Overrides = {} as Overrides) {
  return {
    connect: vi.fn(async () => undefined),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    handleBargeIn: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
    ...overrides,
  };
}

export function createIdleRelayProvider(
  createBridge: RealtimeVoiceProviderPlugin["createBridge"] = () => makeRelayTransport(),
): RealtimeVoiceProviderPlugin {
  return {
    id: "relay-test",
    label: "Relay Test",
    isConfigured: () => true,
    createBridge,
  };
}

export async function drainRelayTestSessions(activeRelaySessions: Map<string, string>) {
  for (const [relaySessionId, connId] of activeRelaySessions) {
    try {
      await stopTalkRealtimeRelaySession({ relaySessionId, connId });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Unknown realtime relay session")) {
        throw error;
      }
    }
  }
  await Promise.all(
    [...drainingRelaySessions].map(
      (session) => session.closing?.completion ?? session.voiceSessionClose ?? Promise.resolve(),
    ),
  );
  activeRelaySessions.clear();
}

type RelaySessionParams = Parameters<typeof createTalkRealtimeRelaySessionRaw>[0];
type RelayFixtureDefaults = "connId" | "providerConfig" | "instructions" | "tools";

export function createTrackedTalkRealtimeRelaySession(
  activeRelaySessions: Map<string, string>,
  params: Omit<RelaySessionParams, "sessionTarget" | "controlSource" | RelayFixtureDefaults> &
    Partial<Pick<RelaySessionParams, RelayFixtureDefaults>> & { sessionKey?: string },
): ReturnType<typeof createTalkRealtimeRelaySessionRaw> {
  const {
    sessionKey,
    connId = "conn-1",
    providerConfig = {},
    instructions = "brief",
    tools = [],
    ...request
  } = params;
  const cfg = params.cfg ?? { agents: { entries: { main: { default: true } } } };
  const capabilities = resolveRealtimeVoiceProviderCapabilities({
    provider: params.provider,
    providerConfig,
    cfg,
    model: params.model,
    surface: "gateway-relay",
  });
  const session = createTalkRealtimeRelaySessionRaw({
    ...request,
    connId,
    providerConfig,
    instructions,
    tools,
    controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
    capabilities,
    context: {
      ...request.context,
      chatAbortControllers: request.context.chatAbortControllers ?? new Map(),
    },
    cfg,
    sessionTarget: prepareTalkSessionTarget(cfg, sessionKey ?? "agent:main:main"),
  });
  activeRelaySessions.set(session.relaySessionId, connId);
  return session;
}
