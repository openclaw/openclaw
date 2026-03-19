import { vi } from "vitest";
import type { Mock } from "vitest";
import { createChatRunState } from "../server-chat.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

export function createActiveRun(
  sessionKey: string,
  params: {
    sessionId?: string;
    owner?: { connId?: string; deviceId?: string };
  } = {},
) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId: params.sessionId ?? `${sessionKey}-session`,
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
    ownerConnId: params.owner?.connId,
    ownerDeviceId: params.owner?.deviceId,
  };
}

export type ChatAbortTestContext = Record<string, unknown> & {
  chatAbortControllers: Map<string, ReturnType<typeof createActiveRun>>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatAbortedRuns: Map<string, number>;
  chatRunState: ReturnType<typeof createChatRunState>;
  removeChatRun: (...args: unknown[]) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (...args: unknown[]) => void;
  nodeSendToSession: (...args: unknown[]) => void;
  logGateway: { warn: (...args: unknown[]) => void };
};

export type ChatAbortRespondMock = Mock<RespondFn>;

export function createChatAbortContext(
  overrides: Record<string, unknown> = {},
): ChatAbortTestContext {
  const {
    chatRunState: overrideChatRunState,
    chatRunBuffers: overrideChatRunBuffers,
    chatDeltaSentAt: overrideChatDeltaSentAt,
    chatAbortedRuns: overrideChatAbortedRuns,
    ...rest
  } = overrides as Record<string, unknown> & {
    chatRunState?: ReturnType<typeof createChatRunState>;
    chatRunBuffers?: Map<string, string>;
    chatDeltaSentAt?: Map<string, number>;
    chatAbortedRuns?: Map<string, number>;
  };
  const chatRunState = overrideChatRunState ?? createChatRunState();

  const seedMap = <T>(target: Map<string, T>, source?: Map<string, T>) => {
    if (!source || source === target) {
      return;
    }
    target.clear();
    for (const [key, value] of source) {
      target.set(key, value);
    }
  };

  seedMap(chatRunState.buffers, overrideChatRunBuffers);
  seedMap(chatRunState.deltaSentAt, overrideChatDeltaSentAt);
  seedMap(chatRunState.abortedRuns, overrideChatAbortedRuns);

  return {
    chatAbortControllers: new Map(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...rest,
    chatRunState,
    chatRunBuffers: chatRunState.buffers,
    chatDeltaSentAt: chatRunState.deltaSentAt,
    chatAbortedRuns: chatRunState.abortedRuns,
  };
}

export async function invokeChatAbortHandler(params: {
  handler: GatewayRequestHandler;
  context: ChatAbortTestContext;
  request: { sessionKey: string; runId?: string };
  client?: {
    connId?: string;
    connect?: {
      device?: { id?: string };
      scopes?: string[];
    };
  } | null;
  respond?: ChatAbortRespondMock;
}): Promise<ChatAbortRespondMock> {
  const respond = params.respond ?? vi.fn();
  await params.handler({
    params: params.request,
    respond: respond as never,
    context: params.context as never,
    req: {} as never,
    client: (params.client ?? null) as never,
    isWebchatConnect: () => false,
  });
  return respond;
}
