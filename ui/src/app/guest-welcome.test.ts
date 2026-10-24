/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { GUEST_WELCOME_ENSURE_METHOD, type GuestWelcomeOptions } from "./guest-welcome-handle.ts";
import { GUEST_WELCOME_PENDING_LIMIT_MS, GuestWelcome } from "./guest-welcome.ts";

const GUEST_AUTH = { role: "operator", scopes: ["operator.sessions.write"], sessionCap: "view" };
const READY = { status: "ready", sessionKey: "agent:main:welcome-sam", agentId: "main" };

type Client = { request: ReturnType<typeof vi.fn> };

function harness(options: {
  responses?: unknown[];
  methods?: string[] | null;
  auth?: Record<string, unknown>;
  home?: boolean;
}) {
  const responses = [...(options.responses ?? [])];
  const makeClient = (): Client => ({
    request: vi.fn(async () => {
      const next = responses.shift();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }),
  });
  const listeners = new Set<() => void>();
  const gateway = {
    connection: { gatewayUrl: "wss://team.example.test" },
    snapshot: {} as Record<string, unknown>,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const connect = (client: Client = makeClient()) => {
    gateway.snapshot = {
      phase: "connected",
      client,
      selfUser: { id: "profile-sam" },
      hello: {
        auth: options.auth ?? GUEST_AUTH,
        features:
          options.methods === null
            ? {}
            : { methods: options.methods ?? [GUEST_WELCOME_ENSURE_METHOD] },
      },
    };
    listeners.forEach((listener) => listener());
    return client;
  };
  const disconnect = () => {
    gateway.snapshot = { phase: "reconnecting", client: null, hello: null };
    listeners.forEach((listener) => listener());
  };
  const openSession = vi.fn();
  const isHomeLanding = vi.fn(async () => options.home ?? true);
  const owner = new GuestWelcome({
    gateway: gateway as unknown as GuestWelcomeOptions["gateway"],
    isHomeLanding,
    openSession,
  });
  const stop = owner.start();
  return { owner, connect, disconnect, openSession, isHomeLanding, responses, stop };
}

let storage: Storage;

beforeEach(() => {
  vi.useFakeTimers();
  storage = createStorageMock();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GuestWelcome", () => {
  it("asks once after a guest connects and lands Home on the created session once per browser", async () => {
    const first = harness({ responses: [{ ...READY, created: true }] });
    const client = first.connect();
    await vi.runAllTimersAsync();
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith(GUEST_WELCOME_ENSURE_METHOD, {});
    expect(first.openSession).toHaveBeenCalledWith(READY.sessionKey, READY.agentId);
    expect(first.owner.presentation).toEqual({ kind: "hidden" });
    first.stop();

    // A reload, another tab, or a later sign-in on this browser keeps Home reachable.
    const again = harness({ responses: [{ ...READY, created: false }] });
    again.connect();
    await vi.runAllTimersAsync();
    expect(again.openSession).not.toHaveBeenCalled();
    expect(again.isHomeLanding).not.toHaveBeenCalled();
  });

  it("never redirects away from a deep link, and still lands later from Home", async () => {
    const deepLink = harness({ responses: [{ ...READY, created: true }], home: false });
    deepLink.connect();
    await vi.runAllTimersAsync();
    expect(deepLink.isHomeLanding).toHaveBeenCalledOnce();
    expect(deepLink.openSession).not.toHaveBeenCalled();
    deepLink.stop();

    const home = harness({ responses: [{ ...READY, created: false }] });
    home.connect();
    await vi.runAllTimersAsync();
    expect(home.openSession).toHaveBeenCalledOnce();
  });

  it("lands only the creating call when the browser cannot remember visits", async () => {
    vi.stubGlobal("localStorage", undefined);
    const existing = harness({ responses: [{ ...READY, created: false }] });
    existing.connect();
    await vi.runAllTimersAsync();
    expect(existing.openSession).not.toHaveBeenCalled();
    const created = harness({ responses: [{ ...READY, created: true }] });
    created.connect();
    await vi.runAllTimersAsync();
    expect(created.openSession).toHaveBeenCalledOnce();
  });

  it("lands only the creating call when storage reads but cannot write", async () => {
    const full = createStorageMock();
    full.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
    vi.stubGlobal("localStorage", full);
    const existing = harness({ responses: [{ ...READY, created: false }] });
    existing.connect();
    await vi.runAllTimersAsync();
    expect(existing.isHomeLanding).toHaveBeenCalledOnce();
    expect(existing.openSession).not.toHaveBeenCalled();
    const created = harness({ responses: [{ ...READY, created: true }] });
    created.connect();
    await vi.runAllTimersAsync();
    expect(created.openSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["the method is not advertised", { methods: [] }],
    ["the Gateway predates the method catalog", { methods: null }],
    [
      "the caller is a team member",
      { auth: { role: "operator", scopes: ["operator.read", "operator.write"] } },
    ],
    ["the caller is an admin", { auth: { role: "operator", scopes: ["operator.admin"] } }],
  ])("changes nothing when %s", async (_label, options) => {
    const { connect, openSession, owner } = harness(options);
    const client = connect();
    await vi.runAllTimersAsync();
    expect(client.request).not.toHaveBeenCalled();
    expect(openSession).not.toHaveBeenCalled();
    expect(owner.presentation).toEqual({ kind: "hidden" });
  });

  it("stays hidden and stops asking when the caller has no invitation", async () => {
    const { connect, disconnect, owner } = harness({ responses: [{ status: "not_applicable" }] });
    const client = connect();
    await vi.runAllTimersAsync();
    expect(owner.presentation).toEqual({ kind: "hidden" });
    disconnect();
    const next = connect();
    await vi.runAllTimersAsync();
    expect(client.request).toHaveBeenCalledOnce();
    expect(next.request).not.toHaveBeenCalled();
  });

  it("polls pending setup with a bounded interval, then lands on ready", async () => {
    const { connect, owner, openSession } = harness({
      responses: [
        { status: "pending", retryAfterMs: 0 },
        { status: "pending", retryAfterMs: 60_000 },
        { ...READY, created: false },
      ],
    });
    const client = connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.presentation).toEqual({ kind: "pending" });
    await vi.advanceTimersByTimeAsync(499);
    expect(client.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(client.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(owner.presentation).toEqual({ kind: "hidden" });
    expect(openSession).toHaveBeenCalledOnce();
  });

  it("turns setup that stays pending into a retryable failure", async () => {
    const pending = { status: "pending", retryAfterMs: 5_000 };
    const { connect, owner, responses } = harness({
      responses: Array.from({ length: 40 }, () => pending),
    });
    const client = connect();
    await vi.advanceTimersByTimeAsync(GUEST_WELCOME_PENDING_LIMIT_MS);
    expect(owner.presentation).toEqual({ kind: "failed", message: null });
    const calls = client.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.request).toHaveBeenCalledTimes(calls);

    responses.splice(0, responses.length, { ...READY, created: true });
    owner.retry();
    expect(owner.presentation).toEqual({ kind: "pending" });
    await vi.runAllTimersAsync();
    expect(client.request).toHaveBeenCalledTimes(calls + 1);
    expect(owner.presentation).toEqual({ kind: "hidden" });
  });

  it("shows failures and transport errors, and tries again on request", async () => {
    const { connect, owner, openSession } = harness({
      responses: [
        { status: "failed", retryable: true, message: "Roboclaw is busy." },
        new Error("socket closed"),
        { ...READY, created: true },
      ],
    });
    const client = connect();
    await vi.runAllTimersAsync();
    expect(owner.presentation).toEqual({ kind: "failed", message: "Roboclaw is busy." });
    owner.retry();
    await vi.runAllTimersAsync();
    expect(owner.presentation).toEqual({ kind: "failed", message: null });
    owner.retry();
    await vi.runAllTimersAsync();
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(owner.presentation).toEqual({ kind: "hidden" });
    expect(openSession).toHaveBeenCalledOnce();
  });

  it("abandons polling on disconnect and asks again on reconnect until ready", async () => {
    const { connect, disconnect, owner } = harness({
      responses: [
        { status: "pending", retryAfterMs: 1_000 },
        { ...READY, created: true },
      ],
    });
    const first = connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(owner.presentation).toEqual({ kind: "pending" });
    disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.request).toHaveBeenCalledOnce();
    const second = connect();
    await vi.runAllTimersAsync();
    expect(second.request).toHaveBeenCalledOnce();
    disconnect();
    const third = connect();
    await vi.runAllTimersAsync();
    expect(third.request).not.toHaveBeenCalled();
  });
});
