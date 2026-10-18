import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { expect, vi } from "vitest";
import {
  WizardNextResultSchema,
  WizardStartResultSchema,
} from "../../../packages/gateway-protocol/src/schema/wizard.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "./types.js";

export const quietGreetingFacts = {
  updateAvailable: null,
  channelHealth: { available: true, degraded: [] },
  recentExternalEdit: false,
  auditSequence: 0,
};

export function expectUnused(...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export function transcriptModule(mocks: {
  appendTurn: ReturnType<typeof vi.fn>;
  appendReset: ReturnType<typeof vi.fn>;
  readTranscriptTailAsync: typeof import("../../system-agent/transcript-store.js").readTranscriptTailAsync;
}) {
  return {
    readTranscriptTailAsync: mocks.readTranscriptTailAsync,
    createSystemAgentTranscriptStore: () => ({
      assertCurrent: () => undefined,
      appendTurn: mocks.appendTurn,
      appendReset: mocks.appendReset,
      readTail: (limit: number, afterLastReset = false) =>
        afterLastReset
          ? mocks.readTranscriptTailAsync(limit, { afterLastReset })
          : mocks.readTranscriptTailAsync(limit),
    }),
  };
}

export function makePassiveEngine() {
  return {
    handle: vi.fn<SystemAgentChatSession["engine"]["handle"]>(async () => ({
      text: "did the thing",
      action: "none",
    })),
    seedHistory: vi.fn(),
    historyLength: vi.fn(() => 0),
    historySince: vi.fn(() => []),
    getPendingOperatorProposal: vi.fn(() => null),
    resolveOperatorApproval: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn(),
    decorateRejoinReply: vi.fn((reply: unknown) => reply),
  };
}

export type ChatResponse = { ok: boolean; payload?: unknown; error?: unknown };
export function startGatewayRequest(
  handler: GatewayRequestHandler | undefined,
  options: Pick<GatewayRequestHandlerOptions, "context" | "params"> &
    Partial<GatewayRequestHandlerOptions>,
) {
  const calls: ChatResponse[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  const pending = Promise.resolve(
    expectDefined(handler, "Gateway handler")({ ...options, respond } as never),
  );
  return { calls, pending };
}

const validateNext = Compile(WizardNextResultSchema);
const validateStart = Compile(WizardStartResultSchema);
export function wizardResponse(calls: ChatResponse[], allowStart = false) {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  const payload = calls[0]?.payload;
  if (validateNext.Check(payload)) {
    return payload;
  }
  if (allowStart && validateStart.Check(payload)) {
    return payload;
  }
  throw new Error("Invalid wizard response");
}

export async function requestChat(
  handler: GatewayRequestHandler | undefined,
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null,
): Promise<ChatResponse> {
  const { calls, pending } = startGatewayRequest(handler, { params, context, client });
  await pending;
  return expectDefined(calls[0], "system-agent response");
}
