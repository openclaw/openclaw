import { vi } from "vitest";

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

export function createChatAbortContext(overrides: Record<string, unknown> = {}) {
  return {
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map<string, number>(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  };
}

export async function invokeChatAbortHandler(params: {
  handler: (args: {
    params: { sessionKey: string; runId?: string };
    respond: never;
    context: never;
    req: never;
    client: never;
    isWebchatConnect: () => boolean;
  }) => Promise<void>;
  context: ReturnType<typeof createChatAbortContext>;
  request: { sessionKey: string; runId?: string };
  client?: {
    connId?: string;
    connect?: {
      device?: { id?: string };
      scopes?: string[];
    };
  } | null;
  respond?: ReturnType<typeof vi.fn>;
}) {
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
