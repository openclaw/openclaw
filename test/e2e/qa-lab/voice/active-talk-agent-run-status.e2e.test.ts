// QA Talk E2E tests cover provider session creation and active-run voice controls.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { talkHandlers } from "../../../../src/gateway/server-methods/talk.ts";
import { createPluginRecord } from "../../../../src/plugins/loader-records.ts";
import { createPluginRegistry } from "../../../../src/plugins/registry.ts";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../../src/plugins/runtime.ts";
import { controlRealtimeVoiceAgentRun } from "../../../../src/talk/agent-run-control.ts";
import type { TalkEvent } from "../../../../src/talk/talk-events.ts";

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function installMockRealtimeProvider() {
  const registry = createPluginRegistry({
    logger: noopLogger,
    runtime: {},
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "qa-talk-realtime",
    name: "QA Talk Realtime",
    source: "test/e2e/qa-lab/voice/active-talk-agent-run-status.e2e.test.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
  });
  const createBrowserSession = vi.fn(async () => ({
    provider: "qa-realtime",
    transport: "provider-websocket" as const,
    protocol: "google-live-bidi" as const,
    clientSecret: "auth_tokens/qa-talk",
    websocketUrl:
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    audio: {
      inputEncoding: "pcm16" as const,
      inputSampleRateHz: 16_000,
      outputEncoding: "pcm16" as const,
      outputSampleRateHz: 24_000,
    },
  }));
  registry.registerRealtimeVoiceProvider(record, {
    id: "qa-realtime",
    label: "QA Realtime",
    isConfigured: () => true,
    createBrowserSession,
    createBridge: vi.fn(),
  });
  setActivePluginRegistry(registry.registry);
  return createBrowserSession;
}

function createControlDeps() {
  return {
    abortEmbeddedAgentRun: vi.fn(() => true),
    queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(async (sessionId: string) => ({
      queued: true as const,
      sessionId,
      target: "embedded_run" as const,
      gatewayHealth: "live" as const,
      enqueuedAtMs: 123,
    })),
    getDiagnosticSessionActivitySnapshot: vi.fn(() => ({
      activeWorkKind: "embedded_run" as const,
      hasActiveEmbeddedRun: true,
    })),
    resolveActiveEmbeddedRunSessionId: vi.fn(() => "session-active"),
  };
}

describe("QA active Talk agent-run status", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("creates a mock realtime session and controls one active agent run", async () => {
    const createBrowserSession = installMockRealtimeProvider();
    const respond = vi.fn();
    await talkHandlers["talk.client.create"]({
      req: { type: "req", id: "create", method: "talk.client.create" },
      params: { sessionKey: "agent:main:main", provider: "qa-realtime" },
      client: { connId: "qa-talk" },
      isWebchatConnect: () => true,
      respond,
      context: {
        getRuntimeConfig: () =>
          ({
            talk: {
              realtime: {
                provider: "qa-realtime",
                providers: { "qa-realtime": {} },
              },
            },
          }) satisfies OpenClawConfig,
      },
    } as never);

    expect(createBrowserSession).toHaveBeenCalledTimes(1);
    expect(createBrowserSession.mock.calls[0]?.[0]).toMatchObject({
      tools: [
        expect.objectContaining({ name: "openclaw_agent_consult" }),
        expect.objectContaining({ name: "openclaw_agent_control" }),
      ],
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ provider: "qa-realtime", transport: "provider-websocket" }),
      undefined,
    );

    const deps = createControlDeps();
    const recentEvents = [
      {
        id: "event-1",
        type: "tool.progress",
        sessionId: "talk-1",
        seq: 1,
        timestamp: new Date(0).toISOString(),
        mode: "realtime",
        transport: "provider-websocket",
        brain: "agent-consult",
        payload: { name: "exec_command", phase: "running" },
      } satisfies TalkEvent,
    ];

    await expect(
      controlRealtimeVoiceAgentRun(
        {
          sessionKey: "agent:main:main",
          text: "status",
          mode: "status",
          recentEvents,
        },
        deps,
      ),
    ).resolves.toMatchObject({
      ok: true,
      active: true,
      message: "OpenClaw is working in exec_command (running).",
    });

    await expect(
      controlRealtimeVoiceAgentRun(
        { sessionKey: "agent:main:main", text: "use the safer path", mode: "steer" },
        deps,
      ),
    ).resolves.toMatchObject({ ok: true, mode: "steer", queued: true });
    await expect(
      controlRealtimeVoiceAgentRun(
        { sessionKey: "agent:main:main", text: "also check migration", mode: "followup" },
        deps,
      ),
    ).resolves.toMatchObject({ ok: true, mode: "followup", queued: true });
    expect(deps.queueEmbeddedAgentMessageWithOutcomeAsync.mock.calls[1]?.[1]).toContain(
      "Spoken follow-up for the current voice call.",
    );

    await expect(
      controlRealtimeVoiceAgentRun(
        { sessionKey: "agent:main:main", text: "cancel", mode: "cancel" },
        deps,
      ),
    ).resolves.toMatchObject({ ok: true, mode: "cancel", aborted: true });
    expect(deps.abortEmbeddedAgentRun).toHaveBeenCalledWith("session-active");
  });
});
