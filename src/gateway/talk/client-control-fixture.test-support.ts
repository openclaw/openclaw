import { vi } from "vitest";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";
import {
  controlBridge,
  controlContext,
  sessionTarget,
} from "./client-gateway-control.test-support.js";

type ControlOptions = Parameters<typeof createTalkClientGatewayControlOwner>[0];
export type ControlOwner = ReturnType<typeof createTalkClientGatewayControlOwner>;

export function controlOptions<
  T extends Pick<ControlOptions, "voiceSessionId" | "connId"> & Partial<ControlOptions>,
>(overrides: T) {
  return {
    sessionTarget,
    context: controlContext(),
    runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
    runAgentConsult: vi.fn(async () => ({ text: "done" })),
    appendTranscript: vi.fn<ControlOptions["appendTranscript"]>(async () => undefined),
    flushTranscript: vi.fn(async () => undefined),
    closeLogicalSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function createControlFixture<T extends Parameters<typeof controlOptions>[0]>(overrides: T) {
  const options = controlOptions(overrides);
  return {
    ...options,
    options,
    owner: createTalkClientGatewayControlOwner(options),
    bridge: controlBridge(),
    closeProvider: vi.fn(async () => undefined),
  };
}

export async function activate(
  owner: ControlOwner,
  closeProvider: () => Promise<void> = vi.fn(async () => undefined),
) {
  await owner.adoptProvider(closeProvider);
  owner.activate();
}
