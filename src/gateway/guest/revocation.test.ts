import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "../server-methods/types.js";
import { emitGatewaySessionEnded } from "../session-end-events.js";
import { GuestAccessController } from "./access-controller.js";
import { GuestGrantStore } from "./grant-store.js";
import {
  createGuestTestHarness,
  createManualGate,
  RecordingGuestSocket,
  type GuestTestHarness,
} from "./guest.test-helpers.js";
import { createGuestShareHandlers } from "./share-rpc.js";

async function revokeThroughRpc(harness: GuestTestHarness, grantId: string): Promise<void> {
  const handler = createGuestShareHandlers({ access: harness.controller })["sessions.share.revoke"];
  if (!handler) {
    throw new Error("sessions.share.revoke handler missing");
  }
  let responseOk: boolean | undefined;
  const params = { grantId };
  await handler({
    req: { type: "req", id: "w1-revoke", method: "sessions.share.revoke", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig: () => ({}),
      guestAccess: harness.controller,
    } as unknown as GatewayRequestContext,
    respond: (ok) => {
      responseOk = ok;
    },
  } as GatewayRequestHandlerOptions);
  expect(responseOk).toBe(true);
}

async function attachRecordingSocket(
  harness: GuestTestHarness,
  code: string,
  clientIp: string,
): Promise<{
  guestId: string;
  grantId: string;
  socket: RecordingGuestSocket;
}> {
  const redeemed = await harness.controller.redeem({ code, clientIp });
  expect(redeemed.ok).toBe(true);
  if (!redeemed.ok) {
    throw new Error("expected guest redeem success");
  }
  const attached = await harness.controller.authenticateConnectionToken(redeemed.connectionToken);
  if (!attached) {
    throw new Error("expected guest attach success");
  }
  const socket = new RecordingGuestSocket();
  harness.controller.registerConnection(attached, socket);
  return { guestId: attached.join.guestId, grantId: attached.grant.grantId, socket };
}

describe("Wave 1 guest live revocation", () => {
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
    for (const harness of harnesses.splice(0)) {
      await harness.stop();
    }
    closeOpenClawStateDatabaseForTest();
  });

  it("W1-T4 integration: Revoke while connected → close 4403 in <1s via fake timers; re-redeem fails (I4)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const harness = await makeHarness({ now: () => Date.now() });
    const grant = harness.createGrant({ expiresAtMs: Date.now() + 60_000 });
    const attached = await attachRecordingSocket(harness, grant.code, "198.51.100.60");
    const startedAt = Date.now();

    await revokeThroughRpc(harness, grant.grant.grantId);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(attached.socket.closes).toEqual([{ code: 4403, reason: "guest grant revoked" }]);
    await expect(
      harness.controller.redeem({ code: grant.code, clientIp: "198.51.100.61" }),
    ).resolves.toMatchObject({ ok: false, reason: "unauthorized" });
    expect(harness.store.listJoins(grant.grant.grantId)).toEqual([]);
  });

  it("W1-T5 integration: Gateway restart → reconnect re-redeems against tombstone → fails (I4)", async () => {
    const harness = await makeHarness();
    const grant = harness.createGrant();
    const redeemed = await harness.redeemOk(grant.code);
    harness.controller.revokeGrant(grant.grant.grantId);
    harness.controller.close();
    harness.store.close();
    closeOpenClawStateDatabaseForTest();

    const reloadedStore = new GuestGrantStore({ stateDir: harness.stateDir });
    const reloadedController = new GuestAccessController({ store: reloadedStore });
    const replay = await reloadedController.redeem({
      code: grant.code,
      clientIp: "198.51.100.62",
    });

    expect(reloadedStore.getGrant(grant.grant.grantId)?.revokedAtMs).toEqual(expect.any(Number));
    expect(replay).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(
      reloadedStore.consumeConnectionToken({ token: redeemed.connectionToken }),
    ).toBeUndefined();
    reloadedController.close();
    reloadedStore.close();
  });

  it("W1-T14 security: Revoke raced against redeem/handshake/refresh at deterministic barriers: no post-revoke socket survives; all 4403/AUTH", async () => {
    const redeemGate = createManualGate();
    const redeemHarness = await makeHarness({ hooks: { beforeRedeemCommit: redeemGate.wait } });
    const redeemGrant = redeemHarness.createGrant();
    const racingRedeem = redeemHarness.controller.redeem({
      code: redeemGrant.code,
      clientIp: "198.51.100.70",
    });
    await redeemGate.entered;
    redeemHarness.controller.revokeGrant(redeemGrant.grant.grantId);
    redeemGate.release();
    await expect(racingRedeem).resolves.toMatchObject({ ok: false, reason: "unauthorized" });
    expect(redeemHarness.connections.countForGrant(redeemGrant.grant.grantId)).toBe(0);

    const handshakeGate = createManualGate();
    const handshakeHarness = await makeHarness({
      hooks: { beforeTokenConsume: handshakeGate.wait },
    });
    const handshakeGrant = handshakeHarness.createGrant();
    const handshakeRedeem = await handshakeHarness.controller.redeem({
      code: handshakeGrant.code,
      clientIp: "198.51.100.71",
    });
    if (!handshakeRedeem.ok) {
      throw new Error("expected handshake race redeem success");
    }
    const racingHandshake = handshakeHarness.controller.authenticateConnectionToken(
      handshakeRedeem.connectionToken,
    );
    await handshakeGate.entered;
    handshakeHarness.controller.revokeGrant(handshakeGrant.grant.grantId);
    handshakeGate.release();
    await expect(racingHandshake).resolves.toBeUndefined();
    expect(handshakeHarness.connections.countForGrant(handshakeGrant.grant.grantId)).toBe(0);

    const refreshGate = createManualGate();
    const refreshHarness = await makeHarness({
      hooks: { beforeTokenRefresh: refreshGate.wait },
    });
    const refreshGrant = refreshHarness.createGrant();
    const attached = await attachRecordingSocket(
      refreshHarness,
      refreshGrant.code,
      "198.51.100.72",
    );
    const racingRefresh = refreshHarness.controller.refreshGuest(attached.guestId);
    await refreshGate.entered;
    refreshHarness.controller.revokeGrant(refreshGrant.grant.grantId);
    refreshGate.release();
    await expect(racingRefresh).resolves.toMatchObject({ ok: false, reason: "unauthorized" });
    expect(attached.socket.closes).toContainEqual({
      code: 4403,
      reason: "guest grant revoked",
    });
    expect(refreshHarness.connections.countForGrant(refreshGrant.grant.grantId)).toBe(0);
  });

  it("W1-T16 integration: Host session end AND delete while shared: all guest sockets closed, redemption invalidated, restart-safe tombstones", async () => {
    const harness = await makeHarness();
    const ended = harness.createGrant({ sessionKey: "agent:main:ended" });
    const deleted = harness.createGrant({ sessionKey: "agent:main:deleted" });
    const endedSocket = await attachRecordingSocket(harness, ended.code, "198.51.100.80");
    const deletedSocket = await attachRecordingSocket(harness, deleted.code, "198.51.100.81");

    emitGatewaySessionEnded({ sessionKey: ended.grant.sessionKey, reason: "reset" });
    emitGatewaySessionEnded({ sessionKey: deleted.grant.sessionKey, reason: "deleted" });

    expect(endedSocket.socket.closes).toContainEqual({
      code: 4403,
      reason: "host session ended",
    });
    expect(deletedSocket.socket.closes).toContainEqual({
      code: 4403,
      reason: "host session ended",
    });
    await expect(
      harness.controller.redeem({ code: ended.code, clientIp: "198.51.100.82" }),
    ).resolves.toMatchObject({ ok: false, reason: "unauthorized" });
    await expect(
      harness.controller.redeem({ code: deleted.code, clientIp: "198.51.100.83" }),
    ).resolves.toMatchObject({ ok: false, reason: "unauthorized" });

    harness.controller.close();
    harness.store.close();
    closeOpenClawStateDatabaseForTest();
    const reloadedStore = new GuestGrantStore({ stateDir: harness.stateDir });
    expect(reloadedStore.getGrant(ended.grant.grantId)?.revokedAtMs).toEqual(expect.any(Number));
    expect(reloadedStore.getGrant(deleted.grant.grantId)?.revokedAtMs).toEqual(expect.any(Number));
    reloadedStore.close();
  });

  it("W1-T17 integration: Deleting one of several shared sessions leaves guests on the others connected", async () => {
    const harness = await makeHarness();
    const deleted = harness.createGrant({ sessionKey: "agent:main:delete-one" });
    const survivor = harness.createGrant({ sessionKey: "agent:main:survive" });
    const deletedSocket = await attachRecordingSocket(harness, deleted.code, "198.51.100.90");
    const survivorSocket = await attachRecordingSocket(harness, survivor.code, "198.51.100.91");

    emitGatewaySessionEnded({ sessionKey: deleted.grant.sessionKey, reason: "deleted" });

    expect(deletedSocket.socket.closes).toContainEqual({
      code: 4403,
      reason: "host session ended",
    });
    expect(survivorSocket.socket.closes).toEqual([]);
    expect(harness.connections.countForGrant(survivor.grant.grantId)).toBe(1);
    await expect(
      harness.controller.redeem({ code: survivor.code, clientIp: "198.51.100.92" }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("W1-T18 integration: Revoke with multiple live joins: fake-timer bound + real-timing smoke; every socket 4403 within bound (I4)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const fakeHarness = await makeHarness({ now: () => Date.now() });
    const fakeGrant = fakeHarness.createGrant({ expiresAtMs: Date.now() + 60_000 });
    const fakeSockets = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        attachRecordingSocket(fakeHarness, fakeGrant.code, `198.51.100.${100 + index}`),
      ),
    );
    const fakeStartedAt = Date.now();
    fakeHarness.controller.revokeGrant(fakeGrant.grant.grantId);
    expect(Date.now() - fakeStartedAt).toBeLessThan(1_000);
    for (const attached of fakeSockets) {
      expect(attached.socket.closes).toContainEqual({
        code: 4403,
        reason: "guest grant revoked",
      });
    }

    vi.useRealTimers();
    const realHarness = await makeHarness();
    const realGrant = realHarness.createGrant();
    const redemptions = await Promise.all(
      Array.from({ length: 3 }, () => realHarness.redeemOk(realGrant.code)),
    );
    const realSockets = await Promise.all(
      redemptions.map((redeemed) => realHarness.connect(redeemed.connectionToken)),
    );
    const startedAt = performance.now();
    const closeResults = realSockets.map(
      (socket) =>
        new Promise<{ code: number; elapsedMs: number }>((resolve) => {
          socket.once("close", (code) =>
            resolve({ code, elapsedMs: performance.now() - startedAt }),
          );
        }),
    );
    realHarness.controller.revokeGrant(realGrant.grant.grantId);
    const closed = await Promise.all(closeResults);

    expect(closed.every((result) => result.code === 4403)).toBe(true);
    expect(Math.max(...closed.map((result) => result.elapsedMs))).toBeLessThan(1_000);
  });
});
