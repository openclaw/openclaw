import assert from "node:assert/strict";
import { expect, type Mock } from "vitest";
import type * as SessionEventHandoff from "../auto-reply/reply/session-event-handoff.js";
import type { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import type { QueuedSessionDelivery } from "../infra/session-delivery-queue.records.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import type { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

type LoadedSessionEntryBase = Awaited<ReturnType<typeof loadSessionEntryAsync>>;
type MockCalls = { mock: { calls: unknown[][] } };
type Fields = Record<string, unknown>;
export type RestartSentinelSessionFixture = Omit<LoadedSessionEntryBase, "agentId"> &
  Partial<Pick<LoadedSessionEntryBase, "agentId">>;

export const createRestartSentinelSessionFixture = (
  canonicalKey: string,
  entry: RestartSentinelSessionFixture["entry"],
  overrides: Partial<RestartSentinelSessionFixture> = {},
): RestartSentinelSessionFixture => ({
  cfg: {},
  entry,
  store: {},
  storePath: "/tmp/sessions.json",
  canonicalKey,
  storeKeys: [canonicalKey],
  legacyKey: undefined,
  ...overrides,
});

export async function appendRestartSentinelTranscriptReceipt(
  params: Parameters<typeof appendAssistantMessageToSessionTranscript>[0],
): ReturnType<typeof appendAssistantMessageToSessionTranscript> {
  const { completeSessionTranscriptCommit } =
    await import("../config/sessions/session-transcript-commit-completion.js");
  await completeSessionTranscriptCommit(
    [
      {
        appended: true,
        messageId: "generated-media-transcript",
        message: {
          role: "assistant",
          content: params.content ?? [],
          openclawDisplayContent: params.displayContent,
        },
      },
    ],
    params.onMessageCommitted,
  );
  return {
    ok: true,
    target: {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "main",
      storePath: "/tmp/sessions.json",
    },
    messageId: "generated-media-transcript",
  };
}

type MediaEntry = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

export const createGeneratedMediaDeliveryEntry = (
  overrides: Partial<MediaEntry> & Pick<MediaEntry, "id" | "messageId">,
): MediaEntry => ({
  kind: "agentTurn",
  sessionKey: "agent:main:main",
  message: "generated image ready",
  enqueuedAt: 1,
  retryCount: 0,
  route: { channel: "discord", to: "channel:123", chatType: "channel" },
  inputProvenance: {
    kind: "inter_session",
    sourceChannel: "internal",
    sourceTool: "image_generate",
  },
  sourceReplyDeliveryMode: "automatic",
  ...overrides,
});

export function expectCapturedQueueContext(stateDir: string) {
  return expect.objectContaining({
    environment: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }),
    admission: expect.objectContaining({
      databasePath: resolveOpenClawStateSqlitePath({
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
      }),
    }),
  });
}

export function expectRecordFields(record: unknown, expected: Fields): Fields {
  assert(record && typeof record === "object", "Expected record");
  const actual = record as Fields;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

export function mockCallArg(mock: MockCalls, callIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  assert(call, `Expected mock call ${callIndex}`);
  return call[0];
}

export const lastMockCallArg = (mock: MockCalls): unknown =>
  mockCallArg(mock, mock.mock.calls.length - 1);

export function expectMockCallFields(mock: MockCalls, expected: Fields, callIndex = 0): Fields {
  return expectRecordFields(mockCallArg(mock, callIndex), expected);
}

export function expectContinuationDispatchFields(
  mock: MockCalls,
  expected: Fields,
  expectedCtx?: Fields,
  callIndex = 0,
): Fields {
  const params = expectMockCallFields(mock, expected, callIndex);
  if (expectedCtx) {
    expectRecordFields(params.ctxPayload, expectedCtx);
  }
  return params;
}

export function expectRestartSentinelTranscriptBroadcast(
  broadcastToConnIds: GatewayBroadcastToConnIdsFn,
  params: { sessionKey: string; report: string; subscribers: ReadonlySet<string> },
): void {
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "session.message",
    expect.objectContaining({
      sessionKey: params.sessionKey,
      message: expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: params.report }],
      }),
    }),
    params.subscribers,
    {
      sessionEventSubscriptionKeys: [params.sessionKey],
      prepareSessionProjection: expect.any(Function),
    },
  );
}

export function configureRestartSessionEventMocks(
  mocks: {
    loadSessionEntryAsync: (
      key: string,
      options?: Parameters<typeof loadSessionEntryAsync>[1],
    ) => Promise<RestartSentinelSessionFixture>;
    resolveSessionTarget: Mock<typeof resolveGatewaySessionStoreTargetInWorker>;
    captureSessionEventTarget: Mock<typeof SessionEventHandoff.captureSessionEventTargetForHost>;
    enqueueSessionEvent: Mock<typeof SessionEventHandoff.enqueueSessionEventForHost>;
  },
  sessionId?: string,
) {
  mocks.resolveSessionTarget
    .mockReset()
    .mockImplementation(async ({ key, agentId, env, assertActive }) => {
      assertActive?.();
      const loaded = await mocks.loadSessionEntryAsync(key, { agentId, env });
      return {
        ...loaded,
        agentId: loaded.agentId ?? agentId ?? "main",
        store: loaded.entry
          ? { ...loaded.store, [loaded.canonicalKey]: loaded.entry }
          : loaded.store,
      };
    });
  mocks.captureSessionEventTarget.mockReset().mockImplementation(async (agentId, sessionKey) => ({
    agentId,
    sessionKey,
    sessionId: sessionId ?? sessionKey,
    generation: "restart-event-test",
  }));
  mocks.enqueueSessionEvent.mockReset().mockImplementation((_text, options) => ({
    id: "restart-event",
    accepted: Promise.resolve({ ok: true }),
    cancel: () => true,
    settled: Promise.resolve().then(async () => {
      await options.onAdopted?.();
      return { status: "completed", executionStarted: true, delivered: false };
    }),
  }));
}

export function createRestartSentinelFixture(payload: RestartSentinelPayload, revision = 123) {
  return { version: 1 as const, revision, payload };
}

export type RestartSentinelInProcessDispatchMock = (
  params: Fields,
  options?: Fields,
) => Promise<Fields>;
