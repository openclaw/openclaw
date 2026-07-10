import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { listGatewayMethods } from "../server-methods-list.js";
import { chatHandlers } from "../server-methods/chat.js";
import { terminalHandlers } from "../server-methods/terminal.js";
import { GUEST_WS_SUBPROTOCOL } from "./access-controller.js";
import {
  createGuestTestHarness,
  createRendezvous,
  expectGuestUpgradeRejected,
  RecordingGuestSocket,
  type GuestTestHarness,
  waitForGuestResponse,
} from "./guest.test-helpers.js";
import { GUEST_RPC_ALLOWLIST } from "./rpc-policy.js";

function expectAuthError(response: Record<string, unknown>) {
  expect(response).toMatchObject({
    type: "res",
    ok: false,
    error: { code: "AUTH" },
  });
}

describe("Wave 1 guest WebSocket attach and lockdown", () => {
  const harnesses: GuestTestHarness[] = [];

  async function makeHarness(
    options: Parameters<typeof createGuestTestHarness>[0] = {},
  ): Promise<GuestTestHarness> {
    const harness = await createGuestTestHarness(options);
    harnesses.push(harness);
    return harness;
  }

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const harness of harnesses.splice(0)) {
      await harness.stop();
    }
  });

  it("W1-T1 integration: Valid code → join + token → WS connect succeeds; token is single-ride, refresh works over socket", async () => {
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const redeemed = await harness.redeemOk(grant.code);

    expect(redeemed).toMatchObject({
      ok: true,
      join: {
        grantId: grant.grant.grantId,
        sessionKey: grant.grant.sessionKey,
        guestId: `guest:${grant.grant.grantId}:1`,
        displayName: "Guest 1",
      },
      connectionToken: expect.any(String),
      connectionTokenExpiresAtMs: expect.any(Number),
    });
    const ws = await harness.connect(redeemed.connectionToken);
    expect(ws.protocol).toBe(GUEST_WS_SUBPROTOCOL);
    await expect(
      expectGuestUpgradeRejected(harness.wsBase, redeemed.connectionToken),
    ).resolves.toBe(401);

    const refresh = await waitForGuestResponse(ws, "refresh-1", {
      type: "req",
      id: "refresh-1",
      method: "guest.token.refresh",
      params: {},
    });
    expect(refresh).toMatchObject({
      type: "res",
      id: "refresh-1",
      ok: true,
      payload: {
        connectionToken: expect.any(String),
        connectionTokenExpiresAtMs: expect.any(Number),
      },
    });
  });

  it("W1-T3 security: Iterate EVERY registered RPC method as guest → AUTH error outside allowlist (I3)", async () => {
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const redeemed = await harness.redeemOk(grant.code);
    const ws = await harness.connect(redeemed.connectionToken);
    const methods = listGatewayMethods();
    expect(methods.length).toBeGreaterThan(100);

    for (const [index, method] of methods.entries()) {
      if (GUEST_RPC_ALLOWLIST.has(method)) {
        continue;
      }
      const id = `method-${index}`;
      const response = await waitForGuestResponse(ws, id, {
        type: "req",
        id,
        method,
        params: {},
      });
      expectAuthError(response);
    }
  });

  it("W1-T6 security: Guest terminal.input / chat.send frames dropped with auth error (I9)", async () => {
    const terminalInput = vi.spyOn(terminalHandlers, "terminal.input");
    const chatSend = vi.spyOn(chatHandlers, "chat.send");
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const redeemed = await harness.redeemOk(grant.code);
    const ws = await harness.connect(redeemed.connectionToken);

    const terminalResponse = await waitForGuestResponse(ws, "terminal", {
      type: "req",
      id: "terminal",
      method: "terminal.input",
      params: { sessionId: "host-pty", data: "rm -rf /\n" },
    });
    const chatResponse = await waitForGuestResponse(ws, "chat", {
      type: "req",
      id: "chat",
      method: "chat.send",
      params: { sessionKey: grant.grant.sessionKey, message: "drive host" },
    });

    expectAuthError(terminalResponse);
    expectAuthError(chatResponse);
    expect(terminalInput).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
  });

  it("W1-T7 unit: Expired connection token rejected at handshake", async () => {
    let now = 1_800_000_000_000;
    const harness = await makeHarness({ now: () => now, tokenTtlMs: 100 });
    const grant = harness.createGrant({ expiresAtMs: now + 60_000 });
    const redeemed = await harness.redeemOk(grant.code);

    now = redeemed.connectionTokenExpiresAtMs;
    await expect(
      expectGuestUpgradeRejected(harness.wsBase, redeemed.connectionToken),
    ).resolves.toBe(401);
    expect(harness.connections.countForGrant(grant.grant.grantId)).toBe(0);
  });

  it("W1-T8 e2e: Two anonymous joins distinct; kick one, the other stays connected", async () => {
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const first = await harness.redeemOk(grant.code);
    const second = await harness.redeemOk(grant.code);
    const firstWs = await harness.connect(first.connectionToken);
    const secondWs = await harness.connect(second.connectionToken);
    const firstClosed = once(firstWs, "close");

    expect(first.join.guestId).not.toBe(second.join.guestId);
    expect(harness.controller.kickGuest(first.join.guestId)).toBe(true);
    const [closeCode] = await firstClosed;
    expect(closeCode).toBe(4403);
    expect(secondWs.readyState).toBe(WebSocket.OPEN);
    expect(harness.connections.countForGrant(grant.grant.grantId)).toBe(1);
  });

  it("W1-T10 security: Token lifecycle matrix: unknown/malformed/wrong-grant/wrong-session/revoked/expired/replayed/stale-after-refresh all fail closed", async () => {
    let now = 1_800_000_000_000;
    const harness = await makeHarness({ now: () => now, tokenTtlMs: 1_000 });
    const grant = harness.createGrant({ expiresAtMs: now + 60_000 });
    const otherGrant = harness.createGrant({
      sessionKey: "agent:main:other-session",
      expiresAtMs: now + 60_000,
    });

    expect(harness.store.consumeConnectionToken({ token: "unknown-token" })).toBeUndefined();
    expect(harness.store.consumeConnectionToken({ token: "\u0000" })).toBeUndefined();

    const wrongGrant = await harness.controller.redeem({
      code: grant.code,
      clientIp: "198.51.100.40",
    });
    expect(wrongGrant.ok).toBe(true);
    if (!wrongGrant.ok) {
      throw new Error("expected wrong-grant fixture redeem success");
    }
    expect(
      harness.store.consumeConnectionToken({
        token: wrongGrant.connectionToken,
        expectedGrantId: otherGrant.grant.grantId,
      }),
    ).toBeUndefined();
    expect(
      harness.store.consumeConnectionToken({
        token: wrongGrant.connectionToken,
        expectedSessionKey: otherGrant.grant.sessionKey,
      }),
    ).toBeUndefined();

    const revoked = await harness.controller.redeem({
      code: grant.code,
      clientIp: "198.51.100.41",
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) {
      throw new Error("expected revoked fixture redeem success");
    }
    harness.controller.revokeGrant(grant.grant.grantId);
    expect(
      harness.store.consumeConnectionToken({ token: revoked.connectionToken }),
    ).toBeUndefined();

    const expiringGrant = harness.createGrant({ expiresAtMs: now + 60_000 });
    const expired = await harness.controller.redeem({
      code: expiringGrant.code,
      clientIp: "198.51.100.42",
    });
    expect(expired.ok).toBe(true);
    if (!expired.ok) {
      throw new Error("expected expired fixture redeem success");
    }
    now = expired.connectionTokenExpiresAtMs;
    expect(
      harness.store.consumeConnectionToken({ token: expired.connectionToken }),
    ).toBeUndefined();

    now += 1;
    const replayGrant = harness.createGrant({ expiresAtMs: now + 60_000 });
    const replayed = await harness.controller.redeem({
      code: replayGrant.code,
      clientIp: "198.51.100.43",
    });
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) {
      throw new Error("expected replay fixture redeem success");
    }
    expect(harness.store.consumeConnectionToken({ token: replayed.connectionToken })).toBeDefined();
    expect(
      harness.store.consumeConnectionToken({ token: replayed.connectionToken }),
    ).toBeUndefined();

    const staleToken = "stale-after-refresh-token";
    harness.store.rotateConnectionToken({
      guestId: replayed.join.guestId,
      token: staleToken,
      expiresAtMs: now + 1_000,
    });
    expect(
      harness.store.consumeConnectionToken({ token: replayed.connectionToken }),
    ).toBeUndefined();
    expect(harness.store.consumeConnectionToken({ token: staleToken })).toBeDefined();
  });

  it("W1-T11 security: Two WS handshakes race one single-ride token: exactly one attaches; consumption atomic", async () => {
    const rendezvous = createRendezvous(2);
    const harness = await makeHarness({ hooks: { beforeTokenConsume: rendezvous } });
    const grant = harness.createGrant();
    const redeemed = await harness.redeemOk(grant.code);

    const attempts = [0, 1].map(
      () =>
        new Promise<{ opened: boolean; ws: WebSocket }>((resolve) => {
          const ws = new WebSocket(
            `${harness.wsBase}/guest/ws?guest_token=${encodeURIComponent(redeemed.connectionToken)}`,
            GUEST_WS_SUBPROTOCOL,
          );
          ws.once("open", () => resolve({ opened: true, ws }));
          ws.once("unexpected-response", (_request, response) => {
            response.resume();
            resolve({ opened: false, ws });
          });
          ws.once("error", () => undefined);
        }),
    );
    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((outcome) => outcome.opened)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.opened)).toHaveLength(1);
    expect(harness.connections.countForGrant(grant.grant.grantId)).toBe(1);
    for (const outcome of outcomes) {
      outcome.ws.terminate();
    }
  });

  it("W1-T12 integration: Refresh rotation: old token invalidated, bounded TTL; no refresh after revoke; missed refresh ⇒ forced close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const now = () => Date.now();
    const harness = await makeHarness({ now, tokenTtlMs: 1_000 });
    const grant = harness.createGrant({ expiresAtMs: now() + 60_000 });
    const redeemed = await harness.controller.redeem({
      code: grant.code,
      clientIp: "198.51.100.50",
    });
    expect(redeemed.ok).toBe(true);
    if (!redeemed.ok) {
      throw new Error("expected refresh fixture redeem success");
    }
    const attached = await harness.controller.authenticateConnectionToken(redeemed.connectionToken);
    expect(attached).toBeDefined();
    if (!attached) {
      throw new Error("expected refresh fixture attach success");
    }
    const socket = new RecordingGuestSocket();
    harness.controller.registerConnection(attached, socket);

    const refreshed = await harness.controller.refreshGuest(attached.join.guestId);
    expect(refreshed).toMatchObject({
      ok: true,
      connectionToken: expect.any(String),
      connectionTokenExpiresAtMs: expect.any(Number),
    });
    if (!refreshed.ok) {
      throw new Error("expected token refresh success");
    }
    expect(refreshed.connectionTokenExpiresAtMs - now()).toBeLessThanOrEqual(1_000);
    expect(refreshed.connectionTokenExpiresAtMs).toBeGreaterThan(now());
    expect(
      harness.store.consumeConnectionToken({ token: redeemed.connectionToken }),
    ).toBeUndefined();

    harness.controller.revokeGrant(grant.grant.grantId);
    await expect(harness.controller.refreshGuest(attached.join.guestId)).resolves.toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
    expect(socket.closes).toContainEqual({ code: 4403, reason: "guest grant revoked" });

    const missedGrant = harness.createGrant({ expiresAtMs: now() + 60_000 });
    const missed = await harness.controller.redeem({
      code: missedGrant.code,
      clientIp: "198.51.100.51",
    });
    expect(missed.ok).toBe(true);
    if (!missed.ok) {
      throw new Error("expected missed refresh fixture redeem success");
    }
    const missedAttach = await harness.controller.authenticateConnectionToken(
      missed.connectionToken,
    );
    if (!missedAttach) {
      throw new Error("expected missed refresh attach success");
    }
    const missedSocket = new RecordingGuestSocket();
    harness.controller.registerConnection(missedAttach, missedSocket);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(missedSocket.closes).toContainEqual({ code: 4401, reason: "guest token expired" });
  });

  it("W1-T13 integration: Consumed token cannot reconnect; new redeem mints new pseudo-identity", async () => {
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const first = await harness.redeemOk(grant.code);
    await harness.connect(first.connectionToken);

    await expect(expectGuestUpgradeRejected(harness.wsBase, first.connectionToken)).resolves.toBe(
      401,
    );
    const second = await harness.redeemOk(grant.code);
    expect(second.join.guestId).not.toBe(first.join.guestId);
    expect(second.join.displayName).toBe("Guest 2");
  });

  it("W1-T19 security: RPC lockdown covers aliases, notifications/batches, malformed frames, pre-auth calls, newly registered methods (I3)", async () => {
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const redeemed = await harness.redeemOk(grant.code);
    const ws = await harness.connect(redeemed.connectionToken);

    await expect(expectGuestUpgradeRejected(harness.wsBase)).resolves.toBe(401);
    const cases: Array<{ id: string; frame: unknown }> = [
      {
        id: "alias-terminal",
        frame: { type: "req", id: "alias-terminal", method: "terminal.write", params: {} },
      },
      {
        id: "alias-chat",
        frame: { type: "req", id: "alias-chat", method: "chat.sendMessage", params: {} },
      },
      { id: "invalid", frame: { type: "req", method: "sessions.list", params: {} } },
      {
        id: "batch-a",
        frame: [
          { type: "req", id: "batch-a", method: "sessions.list", params: {} },
          { type: "req", id: "batch-b", method: "health", params: {} },
        ],
      },
      { id: "invalid", frame: "{" },
      { id: "preauth-connect", frame: { type: "req", id: "preauth-connect", method: "connect" } },
      {
        id: "future-method",
        frame: { type: "req", id: "future-method", method: "plugin.future.registered", params: {} },
      },
    ];
    for (const testCase of cases) {
      const response = await waitForGuestResponse(ws, testCase.id, testCase.frame);
      expectAuthError(response);
    }
  });

  it("W1-T20 security: Guest input via every transport/frame variant: AUTH error AND zero PTY/chat side effects (I9)", async () => {
    const terminalInput = vi.spyOn(terminalHandlers, "terminal.input");
    const chatSend = vi.spyOn(chatHandlers, "chat.send");
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const redeemed = await harness.redeemOk(grant.code);
    const ws = await harness.connect(redeemed.connectionToken);
    const variants: Array<{ id: string; frame: unknown }> = [
      {
        id: "req-terminal",
        frame: { type: "req", id: "req-terminal", method: "terminal.input", params: { data: "x" } },
      },
      {
        id: "req-chat",
        frame: { type: "req", id: "req-chat", method: "chat.send", params: { message: "x" } },
      },
      { id: "invalid", frame: { type: "event", event: "terminal.input", payload: { data: "x" } } },
      { id: "invalid", frame: { method: "chat.send", params: { message: "x" } } },
      {
        id: "batch-terminal",
        frame: [
          { type: "req", id: "batch-terminal", method: "terminal.input", params: { data: "x" } },
          { type: "req", id: "batch-chat", method: "chat.send", params: { message: "x" } },
        ],
      },
      {
        id: "alias-input",
        frame: { type: "req", id: "alias-input", method: "terminal.write", params: { data: "x" } },
      },
    ];
    for (const variant of variants) {
      const response = await waitForGuestResponse(ws, variant.id, variant.frame);
      expectAuthError(response);
    }
    expect(terminalInput).not.toHaveBeenCalled();
    expect(chatSend).not.toHaveBeenCalled();
    expect(harness.store.listJoins(grant.grant.grantId)).toHaveLength(1);
  });
});
