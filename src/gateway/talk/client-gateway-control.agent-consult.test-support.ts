// Shared fixtures for the Talk client agent consult admission suites.
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

export type ConsultParams = Parameters<
  typeof import("../../talk/agent-consult-runtime.js").consultRealtimeVoiceAgent
>[0];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const mocks = {
  close: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  prepareAgentRunAdmission: vi.fn(),
  runEmbeddedAgentCore: vi.fn(),
  controlRealtimeVoiceAgentRun: vi.fn(),
};

export const config = {} as OpenClawConfig;

export const coreParams = {
  config,
  prompt: "check",
  runId: "run-talk",
  sessionId: "session-talk",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-talk",
    sessionKey: "agent:researcher:talk",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];
