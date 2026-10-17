import { vi } from "vitest";
import { createTalkClientGatewayControlOwner } from "./client-gateway-control.js";
import { controlContext, sessionTarget } from "./client-gateway-control.test-support.js";

type ControlOptions = Parameters<typeof createTalkClientGatewayControlOwner>[0];
export type ControlOwner = ReturnType<typeof createTalkClientGatewayControlOwner>;

export function controlOptions(
  overrides: Pick<ControlOptions, "voiceSessionId" | "connId"> & Partial<ControlOptions>,
) {
  return {
    sessionTarget,
    context: controlContext(),
    runToolAgentConsult: vi.fn(async () => ({ text: "done" })),
    runAgentConsult: vi.fn(async () => ({ text: "done" })),
    appendTranscript: vi.fn(async () => undefined),
    flushTranscript: vi.fn(async () => undefined),
    closeLogicalSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

export async function activate(owner: ControlOwner, closeProvider = vi.fn(async () => undefined)) {
  await owner.adoptProvider(closeProvider);
  owner.activate();
}
