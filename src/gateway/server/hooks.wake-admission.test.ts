import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type {
  SessionEventOutcome,
  SessionEventReceipt,
  SessionEventTarget,
} from "../../auto-reply/reply/session-event-contract.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimSystemEventTurn,
  drainSystemEvents,
  enqueueRequiredSystemEventEntry,
  isSystemEventTurnOwned,
  peekDeliverableSystemEventEntries,
  peekSystemEventEntries,
  peekSystemEvents,
} from "../../infra/system-events.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { resolveHooksConfig } from "../hooks.js";

const mocks = vi.hoisted(() => ({
  capture:
    vi.fn<
      typeof import("../../auto-reply/reply/session-event-handoff.js").captureSessionEventTargetForHost
    >(),
  enqueue:
    vi.fn<
      typeof import("../../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
    >(),
  config: vi.fn<() => OpenClawConfig>(),
}));
// mock-isolation: Control ordinary-turn receipts at the HTTP adapter boundary, without model work.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: mocks.capture,
  enqueueSessionEventForHost: mocks.enqueue,
}));
// mock-isolation: The request owns this synthetic config; never read the operator's config.
vi.mock("../../config/io.js", () => ({ getRuntimeConfig: mocks.config }));

const { createGatewayHookDispatcher, createGatewayHooksRequestHandler } =
  await import("./hooks.js");
const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  hooks: { enabled: true, token: "hook-secret" },
};
const sessionKey = "agent:main:main";
const target: SessionEventTarget = {
  agentId: "main",
  sessionKey,
  sessionId: "captured-session",
  generation: "captured-generation",
};
const completed: SessionEventOutcome = {
  status: "completed",
  executionStarted: true,
  delivered: false,
};

function receipt(overrides: Partial<SessionEventReceipt> = {}): SessionEventReceipt {
  return {
    id: "controlled-receipt",
    cancel: vi.fn(() => false),
    accepted: Promise.resolve({ ok: true }),
    settled: Promise.resolve(completed),
    ...overrides,
  };
}

function fixture(dispatcher?: ReturnType<typeof createGatewayHookDispatcher>) {
  let hooks = resolveHooksConfig(config);
  const warn = vi.fn();
  const handler = createGatewayHooksRequestHandler({
    scheduler: createTestGatewayScheduler("fake-timers"),
    deps: {} as never,
    dispatcher,
    getHooksConfig: () => hooks,
    getClientIpConfig: () => ({}),
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
  });
  return {
    handler,
    warn,
    revoke: () => {
      hooks = null;
    },
  };
}

const controlledSettlements: Array<ReturnType<typeof createDeferred<SessionEventOutcome>>> = [];

function controlledOwnedHandoff() {
  const submitted = createDeferred();
  const joined = createDeferred();
  const acceptance = createDeferred<Awaited<SessionEventReceipt["accepted"]>>();
  const settled = createDeferred<SessionEventOutcome>();
  controlledSettlements.push(settled);
  const cancel = vi.fn(() => false);
  let acceptanceReads = 0;
  mocks.enqueue.mockImplementationOnce((_text, options) => {
    const occurrence = options.occurrences?.[0];
    if (!occurrence?.id) {
      throw new Error("expected the hook's queued occurrence");
    }
    const claim = claimSystemEventTurn(options.sessionKey, [occurrence], () => {}, options.agentId);
    expect(claim).toBeDefined();
    submitted.resolve();
    return {
      id: occurrence.id,
      cancel,
      get accepted() {
        acceptanceReads += 1;
        if (acceptanceReads === 2) {
          joined.resolve();
        }
        return acceptance.promise;
      },
      settled: settled.promise,
    };
  });
  return { submitted, joined, acceptance, cancel };
}

async function post(
  handler: ReturnType<typeof createGatewayHooksRequestHandler>,
  mode: "now" | "next-heartbeat" = "now",
  token = "hook-secret",
) {
  const req = Object.assign(Readable.from([JSON.stringify({ text: "Wake notification", mode })]), {
    method: "POST",
    url: "/hooks/wake",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  let body = "";
  const end = vi.fn((chunk: string) => {
    body = chunk;
  });
  const res = { statusCode: 200, setHeader: vi.fn(), end } as unknown as ServerResponse;
  expect(await handler(req, res)).toBe(true);
  return { status: res.statusCode, body, end };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue(config);
  mocks.capture.mockResolvedValue(target);
  mocks.enqueue.mockReturnValue(receipt());
});
afterEach(async () => {
  drainSystemEvents(sessionKey);
  drainSystemEvents("agent:main:global");
  await Promise.all(
    controlledSettlements.splice(0).map((settlement) => {
      settlement.resolve({ status: "cancelled", executionStarted: false, delivered: false });
      return settlement.promise;
    }),
  );
});

describe("authenticated immediate hook wake admission", () => {
  it("rejects unauthenticated requests before capturing or queuing a target", async () => {
    const response = await post(fixture().handler, "now", "wrong");
    expect(response.status).toBe(401);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });

  it.each(["failed", "cancelled"] as const)(
    "responds after acceptance and logs a later %s outcome without another handoff",
    async (status) => {
      const settled = createDeferred<SessionEventOutcome>();
      mocks.enqueue.mockReturnValue(receipt({ settled: settled.promise }));
      const { handler, warn } = fixture();
      const response = await post(handler);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ ok: true, eventOutcome: "queued" });
      expect(warn).not.toHaveBeenCalled();
      expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(
        "Wake notification",
        expect.objectContaining({ expectedTarget: target, createIfMissing: true, source: "hook" }),
      );

      settled.resolve({
        status,
        executionStarted: false,
        delivered: false,
        error: "missing route",
      });
      await settled.promise;
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "hook wake failed",
        expect.objectContaining({ status, error: "missing route" }),
      );
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      expect(response.end).toHaveBeenCalledOnce();
    },
  );

  it.each(["capture", "acceptance"] as const)(
    "returns 503 after failed %s without leaving a pending event",
    async (phase) => {
      if (phase === "capture") {
        mocks.capture.mockRejectedValueOnce(new Error("session storage unavailable"));
      } else {
        mocks.enqueue.mockReturnValueOnce(
          receipt({
            accepted: Promise.resolve({ ok: false, error: "session storage unavailable" }),
          }),
        );
      }
      const response = await post(fixture().handler);
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        error: "session storage unavailable",
      });
      expect(peekSystemEvents(sessionKey)).toEqual([]);
      expect(mocks.capture).toHaveBeenCalledOnce();
      expect(mocks.enqueue).toHaveBeenCalledTimes(phase === "capture" ? 0 : 1);
    },
  );

  it.each(["capture", "acceptance"] as const)(
    "rejects a config replacement during %s without recapturing the destination",
    async (phase) => {
      const reached = createDeferred();
      const release = createDeferred();
      if (phase === "capture") {
        mocks.capture.mockImplementationOnce(async () => {
          reached.resolve();
          await release.promise;
          return target;
        });
      } else {
        mocks.enqueue.mockImplementationOnce(() => {
          reached.resolve();
          return receipt({ accepted: release.promise.then(() => ({ ok: true })) });
        });
      }
      const { handler, revoke } = fixture();
      const responsePromise = post(handler);
      await reached.promise;
      revoke();
      release.resolve();
      const response = await responsePromise;
      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        error: "hook configuration changed; retry request",
      });
      expect(response.end).toHaveBeenCalledOnce();
      expect(mocks.capture).toHaveBeenCalledOnce();
      expect(mocks.enqueue).toHaveBeenCalledTimes(phase === "capture" ? 0 : 1);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    },
  );

  it.each([
    { accepted: true, global: false },
    { accepted: false, global: false },
    { accepted: true, global: true },
    { accepted: false, global: true },
  ])(
    "adopts a deferred occurrence for an immediate wake (accepted: $accepted, global: $global)",
    async ({ accepted, global }) => {
      const queueKey = global ? "agent:main:global" : sessionKey;
      const expectedTarget = global ? { ...target, sessionKey: "global" } : target;
      if (global) {
        mocks.config.mockReturnValue({ ...config, session: { scope: "global" } });
        mocks.capture.mockResolvedValue(expectedTarget);
      }
      const { handler } = fixture();
      const deferred = await post(handler, "next-heartbeat");
      expect(deferred.status).toBe(200);
      const original = peekSystemEventEntries(queueKey);
      expect(original).toHaveLength(1);
      expect(mocks.enqueue).not.toHaveBeenCalled();

      const handoffReached = createDeferred();
      const acceptance = createDeferred<Awaited<SessionEventReceipt["accepted"]>>();
      mocks.enqueue.mockImplementationOnce(() => {
        handoffReached.resolve();
        return receipt({ accepted: acceptance.promise });
      });
      let responded = false;
      const immediate = post(handler).then((response) => {
        responded = true;
        return response;
      });
      try {
        await awaitGateBeforeSettlement(
          handoffReached.promise,
          immediate,
          "Immediate wake returned without adopting the deferred occurrence",
        );
        expect(responded).toBe(false);
        expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(
          "Wake notification",
          expect.objectContaining({
            occurrences: [original[0]],
            expectedTarget,
            preserveOccurrenceOnRejection: true,
          }),
        );
        expect(peekSystemEventEntries(queueKey)).toEqual(original);
      } finally {
        acceptance.resolve(accepted ? { ok: true } : { ok: false, error: "admission refused" });
        await immediate;
      }
      const response = await immediate;
      expect(response.status).toBe(accepted ? 200 : 503);
      expect(JSON.parse(response.body)).toMatchObject(
        accepted
          ? { ok: true, eventOutcome: "coalesced" }
          : { ok: false, error: "admission refused" },
      );
      if (!accepted) {
        expect(peekSystemEventEntries(queueKey)).toEqual(original);
        expect(peekDeliverableSystemEventEntries(queueKey)).toEqual(original);
      }
      expect(mocks.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "joins concurrent immediate requests to one admission decision (accepted: %s)",
    async (accepted) => {
      const { handler } = fixture();
      const handoff = controlledOwnedHandoff();
      const first = post(handler);
      let second: ReturnType<typeof post> | undefined;
      try {
        await awaitGateBeforeSettlement(
          handoff.submitted.promise,
          first,
          "First wake never submitted",
        );
        second = post(handler);
        await awaitGateBeforeSettlement(
          handoff.joined.promise,
          second,
          "Coalesced wake returned before joining the original acceptance",
        );
        expect(mocks.enqueue).toHaveBeenCalledOnce();
        expect(handoff.cancel).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
        expect(peekDeliverableSystemEventEntries(sessionKey)).toEqual([]);
      } finally {
        handoff.acceptance.resolve(
          accepted ? { ok: true } : { ok: false, error: "admission refused" },
        );
        await Promise.all([first, second]);
      }
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual(
        accepted ? [200, 200] : [503, 503],
      );
      expect(responses.map((response) => JSON.parse(response.body))).toMatchObject(
        accepted
          ? [
              { ok: true, eventOutcome: "queued" },
              { ok: true, eventOutcome: "coalesced" },
            ]
          : [
              { ok: false, error: "admission refused" },
              { ok: false, error: "admission refused" },
            ],
      );
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      if (accepted) {
        expect(handoff.cancel).not.toHaveBeenCalled();
      } else {
        expect(handoff.cancel).toHaveBeenCalledOnce();
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      }
    },
  );

  it("does not cancel the original wake when a joining request loses its config authority", async () => {
    const dispatcher = createGatewayHookDispatcher({
      deps: {} as never,
      logHooks: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
    });
    const original = fixture(dispatcher);
    const joining = fixture(dispatcher);
    const handoff = controlledOwnedHandoff();
    const first = post(original.handler);
    let second: ReturnType<typeof post> | undefined;
    try {
      await awaitGateBeforeSettlement(
        handoff.submitted.promise,
        first,
        "First wake never submitted",
      );
      second = post(joining.handler);
      await awaitGateBeforeSettlement(
        handoff.joined.promise,
        second,
        "Joining request returned before original admission",
      );
      joining.revoke();
    } finally {
      handoff.acceptance.resolve({ ok: true });
      await Promise.all([first, second]);
    }
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 409]);
    expect(handoff.cancel).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    const retained = peekSystemEventEntries(sessionKey);
    expect(retained).toHaveLength(1);
    const occurrence = retained[0];
    if (!occurrence) {
      throw new Error("expected the original occurrence");
    }
    expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(true);
  });

  it("refuses a foreign-owned occurrence without consuming or cancelling it", async () => {
    const occurrence = enqueueRequiredSystemEventEntry("Wake notification", { sessionKey });
    if (!occurrence) {
      throw new Error("expected a queued occurrence");
    }
    const cancel = vi.fn();
    const owner = claimSystemEventTurn(sessionKey, [occurrence], cancel, "main");
    if (!owner) {
      throw new Error("expected foreign queue ownership");
    }
    try {
      const response = await post(fixture().handler);
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        error: "Hook wake acceptance is owned by another dispatcher",
      });
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(sessionKey)).toEqual([occurrence]);
      expect(isSystemEventTurnOwned(sessionKey, occurrence)).toBe(true);
    } finally {
      owner.release();
    }
  });

  it("leaves next-heartbeat wakes passive and coalesces their duplicate occurrence", async () => {
    const { handler } = fixture();
    const first = await post(handler, "next-heartbeat");
    const duplicate = await post(handler, "next-heartbeat");
    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ eventOutcome: "queued" });
    expect(JSON.parse(duplicate.body)).toMatchObject({ eventOutcome: "coalesced" });
    expect(peekSystemEvents(sessionKey)).toEqual(["Wake notification"]);
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
