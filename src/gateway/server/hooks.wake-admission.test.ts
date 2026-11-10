import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import type {
  SessionEventOutcome,
  SessionEventReceipt,
  SessionEventTarget,
} from "../../auto-reply/reply/session-event-contract.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeferredHookWake } from "../../cron/wake-contract.js";
import {
  claimSystemEventTurn,
  drainSystemEvents,
  enqueueRequiredSystemEventEntry,
  enqueueAutomationSystemEvent,
  isSystemEventTurnOwned,
  peekSystemEventEntries,
  peekSystemEvents,
} from "../../infra/system-events.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createMockServerResponse } from "../../test-utils/mock-http-response.js";
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
  defer: vi.fn<DeferredHookWake>(),
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
    deferHookWake: mocks.defer,
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

function controlledHandoff(owned: boolean) {
  const submitted = createDeferred();
  const joined = createDeferred();
  const acceptance = createDeferred<Awaited<SessionEventReceipt["accepted"]>>();
  const settled = createDeferred<SessionEventOutcome>();
  controlledSettlements.push(settled);
  const cancel = vi.fn(() => false);
  let acceptanceReads = 0;
  mocks.enqueue.mockImplementationOnce((_text, options) => {
    const occurrence = options.occurrences?.[0];
    assert(occurrence?.id, "expected the hook's queued occurrence");
    if (owned) {
      expect(
        claimSystemEventTurn(options.sessionKey, [occurrence], () => {}, options.agentId),
      ).toBeDefined();
    }
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
  text = "Wake notification",
) {
  const req = Object.assign(Readable.from([JSON.stringify({ text, mode })]), {
    method: "POST",
    url: "/hooks/wake",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  const res = createMockServerResponse();
  const end = vi.spyOn(res, "end");
  expect(await handler(req, res)).toBe(true);
  return { status: res.statusCode, body: res.body ?? "", end };
}

function expectWake(
  response: Awaited<ReturnType<typeof post>>,
  status: number,
  body: Record<string, unknown>,
) {
  expect(response.status).toBe(status);
  expect(JSON.parse(response.body)).toMatchObject(body);
}

const acceptanceResult = (accepted: boolean) =>
  accepted ? { ok: true as const } : { ok: false as const, error: "admission refused" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockReturnValue(config);
  mocks.capture.mockResolvedValue(target);
  mocks.enqueue.mockReturnValue(receipt());
  mocks.defer.mockResolvedValue({ ok: true, eventOutcome: "queued" });
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
    "responds at acceptance and logs later %s without another handoff",
    async (status) => {
      const settled = createDeferred<SessionEventOutcome>();
      mocks.enqueue.mockReturnValue(receipt({ settled: settled.promise }));
      const { handler, warn } = fixture();
      const response = await post(handler);
      expectWake(response, 200, { ok: true, eventOutcome: "queued" });
      expect(warn).not.toHaveBeenCalled();

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

  it.each(["capture", "acceptance", "scheduler"] as const)(
    "returns 503 after failed %s without leaving a pending event",
    async (phase) => {
      if (phase === "capture") {
        mocks.capture.mockRejectedValueOnce(new Error("session storage unavailable"));
      } else if (phase === "acceptance") {
        mocks.enqueue.mockReturnValueOnce(
          receipt({
            accepted: Promise.resolve({ ok: false, error: "session storage unavailable" }),
          }),
        );
      } else {
        mocks.defer.mockResolvedValueOnce({ ok: false, reason: "session storage unavailable" });
      }
      const response = await post(
        fixture().handler,
        phase === "scheduler" ? "next-heartbeat" : "now",
      );
      expectWake(response, 503, {
        ok: false,
        error: "session storage unavailable",
      });
      expect(peekSystemEvents(sessionKey)).toEqual([]);
      expect(mocks.enqueue).toHaveBeenCalledTimes(phase === "acceptance" ? 1 : 0);
    },
  );

  it.each([
    ["now", "capture"],
    ["now", "acceptance"],
    ["next-heartbeat", "capture"],
    ["next-heartbeat", "acceptance"],
  ] as const)("rejects config replacement during %s %s without recapture", async (mode, phase) => {
    const reached = createDeferred();
    const release = createDeferred();
    if (phase === "capture") {
      mocks.capture.mockImplementationOnce(async () => {
        reached.resolve();
        await release.promise;
        return target;
      });
    } else if (mode === "now") {
      mocks.enqueue.mockImplementationOnce(() => {
        reached.resolve();
        return receipt({ accepted: release.promise.then(() => ({ ok: true })) });
      });
    } else {
      mocks.defer.mockImplementationOnce(async ({ commitGuard }) => {
        reached.resolve();
        await release.promise;
        commitGuard();
        return { ok: true, eventOutcome: "queued" };
      });
    }
    const { handler, revoke } = fixture();
    const responsePromise = post(handler, mode);
    await awaitGateBeforeSettlement(reached.promise, responsePromise, "Admission did not start");
    revoke();
    release.resolve();
    const response = await responsePromise;
    expectWake(response, 409, {
      error: "hook configuration changed; retry request",
    });
    expect(response.end).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledTimes(mode === "now" && phase === "acceptance" ? 1 : 0);
    if (mode === "next-heartbeat") {
      expect(mocks.defer).toHaveBeenCalledTimes(phase === "capture" ? 0 : 1);
    }
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });

  it.each([
    ["pending", true, false],
    ["pending", false, false],
    ["pending", true, true],
    ["pending", false, true],
    ["joining", true, false],
    ["joining", false, false],
    ["revoked", true, false],
  ] as const)(
    "preserves %s wake custody (accepted: %s, global: %s)",
    async (kind, accepted, global) => {
      const existing = kind === "pending";
      const queueKey = global ? "agent:main:global" : sessionKey;
      const expectedTarget = global ? { ...target, sessionKey: "global" } : target;
      if (global) {
        mocks.config.mockReturnValue({ ...config, session: { scope: "global" } });
        mocks.capture.mockResolvedValue(expectedTarget);
      }
      const dispatcher = createGatewayHookDispatcher({
        deps: {} as never,
        logHooks: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as never,
      });
      const first = fixture(dispatcher);
      const joining = fixture(dispatcher);
      if (existing) {
        enqueueRequiredSystemEventEntry("Wake notification", { sessionKey: queueKey });
      }
      const handoff = controlledHandoff(!existing);
      let original = peekSystemEventEntries(queueKey);
      let responded = 0;
      const send = (handler: typeof first.handler) =>
        post(handler).then((response) => {
          responded++;
          return response;
        });
      const firstRequest = send(first.handler);
      const requests = [firstRequest];
      try {
        await awaitGateBeforeSettlement(
          handoff.submitted.promise,
          firstRequest,
          "First wake never submitted",
        );
        if (existing) {
          expect(peekSystemEventEntries(queueKey)).toEqual(original);
        } else {
          original = peekSystemEventEntries(queueKey);
        }
        if (!existing) {
          const second = send(kind === "revoked" ? joining.handler : first.handler);
          requests.push(second);
          await awaitGateBeforeSettlement(
            handoff.joined.promise,
            second,
            "Joining wake did not wait for admission",
          );
        }
        expect(responded).toBe(0);
        expect(handoff.cancel).not.toHaveBeenCalled();
        expect(original.map((event) => isSystemEventTurnOwned(queueKey, event))).toEqual([
          !existing,
        ]);
        expect(mocks.enqueue.mock.calls[0]?.[1]).toMatchObject({
          occurrences: original,
          expectedTarget,
        });
        if (kind === "revoked") {
          joining.revoke();
        }
      } finally {
        handoff.acceptance.resolve(acceptanceResult(accepted));
        await Promise.all(requests);
      }
      (await Promise.all(requests)).forEach((response, index) => {
        const revoked = kind === "revoked" && index === 1;
        expectWake(
          response,
          revoked ? 409 : accepted ? 200 : 503,
          revoked
            ? { error: "hook configuration changed; retry request" }
            : accepted
              ? { ok: true, eventOutcome: existing || index === 1 ? "coalesced" : "queued" }
              : acceptanceResult(false),
        );
      });
      expect(mocks.enqueue).toHaveBeenCalledOnce();
      expect(handoff.cancel).toHaveBeenCalledTimes(accepted ? 0 : 1);
      expect(peekSystemEventEntries(queueKey)).toEqual(existing || accepted ? original : []);
      if (existing || accepted) {
        expect(original.map((event) => isSystemEventTurnOwned(queueKey, event))).toEqual([
          !existing,
        ]);
      }
    },
  );

  it("refuses a foreign-owned occurrence without consuming or cancelling it", async () => {
    const occurrence = enqueueRequiredSystemEventEntry("Wake notification", { sessionKey });
    assert(occurrence, "expected a queued occurrence");
    const cancel = vi.fn();
    const owner = claimSystemEventTurn(sessionKey, [occurrence], cancel, "main");
    assert(owner, "expected foreign queue ownership");
    try {
      const response = await post(fixture().handler);
      expectWake(response, 503, {
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

  it.each(["queued", "coalesced"] as const)(
    "returns deferred scheduler's %s receipt without immediate handoff",
    async (eventOutcome) => {
      mocks.defer.mockResolvedValueOnce({ ok: true, eventOutcome });
      const response = await post(fixture().handler, "next-heartbeat");
      expectWake(response, 200, { ok: true, eventOutcome });
      expect(peekSystemEvents(sessionKey)).toEqual([]);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );

  it.for([
    { name: "ASCII", text: "A".repeat(2001) },
    { name: "CJK", text: "界".repeat(501) },
  ])("refuses oversized $name deferrals but accepts immediate wakes", async ({ text }) => {
    mocks.defer.mockImplementation(async ({ text: deferredText, commitGuard }) => {
      const eventOutcome = enqueueAutomationSystemEvent(
        deferredText,
        { sessionKey },
        {
          jobId: "scheduled-receiver",
          assertCurrent: commitGuard,
        },
      );
      return { ok: true, eventOutcome };
    });
    const { handler } = fixture();
    const rejected = await post(handler, "next-heartbeat", "hook-secret", text);
    expectWake(rejected, 503, {
      ok: false,
      error:
        'Deferred automation notices for this scheduled occurrence exceed the prompt limit of 2000 weighted characters. Shorten the notice or use mode "now".',
    });
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();

    const shorter = await post(handler, "next-heartbeat", "hook-secret", "Short notice");
    expectWake(shorter, 200, { ok: true, eventOutcome: "queued" });
    expect(peekSystemEvents(sessionKey)).toEqual(["Short notice"]);

    const immediate = await post(handler, "now", "hook-secret", text);
    expect(immediate.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(
      text,
      expect.objectContaining({ source: "hook" }),
    );
  });
});
