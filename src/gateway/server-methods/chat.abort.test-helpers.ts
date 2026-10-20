/**
 * Shared helpers for chat abort gateway method tests.
 */
import { afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  abortSessionControllerInput,
  retireSessionControllerInput,
  releaseSessionControllerClaim,
  claimSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import type {
  RpcSourceAdapter,
  RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { createChatRunState, type ChatRunState } from "../server-chat-state.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

type TestChatRunRecord =
  ReturnType<typeof createChatRunState>["runs"] extends Map<string, infer Record> ? Record : never;

export function createAbortTestRunState(entries: Array<[string, Partial<TestChatRunRecord>]>) {
  const state = createChatRunState();
  for (const [runId, record] of entries) {
    Object.assign(state.getOrCreate(runId), record);
  }
  return state;
}

const testSources = new Set<RpcSourceRef>();
const testAdmissions: Array<Promise<{ error: unknown } | undefined>> = [];
afterEach(async () => {
  const settlements = [...testSources].map((ref) => ref.input.settlement.promise);
  for (const ref of testSources) {
    const claim = ref.input.claim;
    const operation = claim?.operation;
    if (operation?.abortFrozen && !operation.result && claim && !claim.released) {
      operation.complete();
      releaseSessionControllerClaim(claim);
    } else {
      abortSessionControllerInput(ref.input, "Fixture finished");
    }
    if (!ref.input.claim) {
      retireSessionControllerInput(ref.input);
    }
  }
  testSources.clear();
  await Promise.allSettled(settlements);
  const results = await Promise.all(testAdmissions.splice(0));
  const failures = results.flatMap((result) => (result ? [result.error] : []));
  if (failures.length) {
    throw new AggregateError(failures, "Fixture admission failed");
  }
});

export function createActiveRun(
  sessionKey: string,
  params: {
    sessionId?: string;
    storeScope?: string;
    storePath?: string;
    agentId?: string;
    controlUiVisible?: boolean;
    owner?: { connId?: string; deviceId?: string };
    turnKind?: "main" | "btw";
    queued?: boolean;
    runId?: string;
  } = {},
): RpcSourceRef {
  const { sessionId = `${sessionKey}-session`, agentId, storeScope, storePath } = params;
  const adapter: RpcSourceAdapter = {
    controlUiVisible: params.controlUiVisible,
    requester: params.owner
      ? { connectionId: params.owner.connId, deviceId: params.owner.deviceId }
      : undefined,
    turnKind: params.turnKind,
  };
  const input = reserveSessionControllerSource(sessionKey, {
    protocolRunId: params.runId,
    target: captureSessionTarget({
      storeScope:
        storeScope ??
        storePath ??
        resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
          agentId: agentId ?? parseAgentSessionKey(sessionKey)?.agentId ?? "main",
        }),
      sessionKey,
      incarnation: sessionId,
      agentId,
    }),
    policy: { mode: "followup" },
    adapter,
  });
  const ref = { input, adapter };
  testSources.add(ref);
  if (!params.queued) {
    // Drive the actual mailbox admission before attaching the operation. Each
    // fixture uses its physical store owner, not a fake activity field.
    let started = false;
    const admission = claimSessionControllerTask(input, (claim) => {
      started = true;
      const operation = createReplyOperation({
        sessionKey,
        sessionId,
        agentId,
        resetTriggered: false,
        mailboxClaim: claim,
        target: input.target,
      });
      // This fixture owns a real producer that returns after observing cancellation.
      // Stop must still join its finally block rather than treating abort as settlement.
      void (async () => {
        try {
          await new Promise<void>((resolve) => {
            input.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          operation.complete();
          releaseSessionControllerClaim(claim);
        }
      })();
    });
    testAdmissions.push(
      admission.then(
        () => undefined,
        (error: unknown) => (!started && input.abortSignal.aborted ? undefined : { error }),
      ),
    );
  }
  return ref;
}

type ChatAbortTestContext = Record<string, unknown> & {
  chatRunState: ChatRunState;
  dedupe: Map<string, unknown>;
  removeChatRun: (
    ...args: unknown[]
  ) => { sessionKey: string; agentId?: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (...args: unknown[]) => void;
  nodeSendToSession: (...args: unknown[]) => void;
  logGateway: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};

type ChatAbortRespondMock = Mock<RespondFn>;

export function createChatAbortContext(
  overrides: Record<string, unknown> & {
    sources?: Iterable<readonly [string, RpcSourceRef]>;
  } = {},
): ChatAbortTestContext {
  const { sources, ...contextOverrides } = overrides;
  rpcSourceTesting.reset(sources);
  const chatRunState =
    contextOverrides.chatRunState && typeof contextOverrides.chatRunState === "object"
      ? (contextOverrides.chatRunState as ChatRunState)
      : createChatRunState();
  const context = {
    chatRunState,
    dedupe: new Map(),
    removeChatRun: vi.fn((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    getRuntimeConfig: () => ({}),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { info: vi.fn(), warn: vi.fn() },
    ...contextOverrides,
  } as unknown as ChatAbortTestContext;
  // Synthetic registrations retire through the real index owner only after the
  // producer's exact source receipt, preserving replacements and foreign runs.
  for (const [runId, ref] of rpcSourceTesting) {
    const remove = () => rpcSourceTesting.deleteExpected(runId, ref);
    void ref.input.settlement.promise.then(remove, remove);
  }
  return context;
}

export async function invokeChatAbortHandler(params: {
  handler: GatewayRequestHandler;
  context: ChatAbortTestContext;
  request: {
    sessionKey: string;
    agentId?: string;
    runId?: string;
    preserveSideRuns?: boolean;
    discardPendingInput?: boolean;
  };
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
