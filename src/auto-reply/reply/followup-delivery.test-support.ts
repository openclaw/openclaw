import { vi } from "vitest";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import type { SettledAgentTurn } from "./agent-runner-execution.types.js";
import type { AdmittedFollowupTurn } from "./followup-turn-admission.js";

export function createTurn(overrides: Partial<AdmittedFollowupTurn> = {}): AdmittedFollowupTurn {
  return {
    runId: "run-1",
    queued: {
      prompt: "queued",
      enqueuedAt: 1,
      originatingChannel: "discord",
      originatingTo: "channel:C1",
      run: {
        agentId: "agent",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        provider: "anthropic",
        model: "claude",
        messageProvider: "discord",
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    },
    operation: {} as AdmittedFollowupTurn["operation"],
    config: {},
    session: {
      kind: "session",
      key: "main",
      current: () => undefined,
      publish: () => undefined,
      adopt: () => undefined,
    },
    sendPolicy: "allow",
    preflightCompactionApplied: false,
    ...overrides,
  };
}

export function createSettledExecution(finalText = ""): {
  runId: string;
  outcome: SettledAgentTurn;
} {
  return {
    runId: "run-1",
    outcome: {
      kind: "settled",
      status: "ok",
      result: {
        payloads: finalText ? [{ text: finalText }] : [],
        meta: { durationMs: 0, finalAssistantVisibleText: finalText },
      },
      resolved: { provider: "anthropic", model: "claude" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
  };
}

export function createAccounting(
  payloadArray: ReplyPayload[] = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    payloadArray,
    providerUsed: "anthropic",
    modelUsed: "claude",
    preserveUserFacingSessionState: false,
    replyUsageState: {},
    usage: undefined,
    terminalFailurePayload: undefined,
    ...overrides,
  } as never;
}

export const createDefaults = (onBlockReply: (payload: ReplyPayload) => Promise<void>) => ({
  defaultModel: "claude",
  typingMode: "never" as const,
  typing: {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
  },
  opts: { onBlockReply },
});
