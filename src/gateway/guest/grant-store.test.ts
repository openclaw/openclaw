import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { GuestGrantStore, type GuestGrant } from "./grant-store.js";

const SHARE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;

describe("GuestGrantStore", () => {
  const tempDirs: string[] = [];
  const stores: GuestGrantStore[] = [];

  function makeStore(options: { now?: () => number; sweepIntervalMs?: number } = {}) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-guest-grants-"));
    tempDirs.push(stateDir);
    const store = new GuestGrantStore({ stateDir, ...options });
    stores.push(store);
    return { stateDir, store };
  }

  function createGrant(
    store: GuestGrantStore,
    overrides: Partial<Pick<GuestGrant, "expiresAtMs" | "replayPolicy">> = {},
  ) {
    return store.createGrant({
      sessionKey: "agent:main:guest-demo",
      audience: "open",
      createdBy: "device:test-host",
      ...overrides,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    for (const store of stores.splice(0)) {
      store.close();
    }
    closeOpenClawStateDatabaseForTest();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("W0-T1 integration: grant persists to disk and survives a store reload", () => {
    const now = 1_800_000_000_000;
    const { stateDir, store } = makeStore({ now: () => now });
    const created = createGrant(store, {
      expiresAtMs: now + 60_000,
      replayPolicy: "full",
    });

    expect(created.code).toMatch(SHARE_CODE_PATTERN);
    store.close();
    closeOpenClawStateDatabaseForTest();

    const reloaded = new GuestGrantStore({ stateDir, now: () => now });
    stores.push(reloaded);
    expect(reloaded.getGrant(created.grant.grantId)).toEqual(created.grant);
    expect(reloaded.listGrants({ sessionKey: created.grant.sessionKey })).toEqual([created.grant]);
  });

  it("W0-T3 unit: revoke tombstones; a revoked grant is un-redeemable", () => {
    const now = 1_800_000_000_000;
    const { store } = makeStore({ now: () => now });
    const created = createGrant(store, { expiresAtMs: now + 60_000 });

    expect(store.findRedeemableGrant(created.code)?.grantId).toBe(created.grant.grantId);
    const revoked = store.revokeGrant(created.grant.grantId);

    expect(revoked).toMatchObject({ grantId: created.grant.grantId, revokedAtMs: now });
    expect(store.getGrant(created.grant.grantId)?.revokedAtMs).toBe(now);
    expect(store.findRedeemableGrant(created.code)).toBeUndefined();
  });

  it("W0-T4 unit: expired grants are un-redeemable by lazy check and periodic sweeper", async () => {
    vi.useFakeTimers();
    let now = 1_800_000_000_000;
    const { store } = makeStore({ now: () => now, sweepIntervalMs: 25 });
    const lazyExpired = createGrant(store, { expiresAtMs: now + 10 });

    now += 11;
    expect(store.findRedeemableGrant(lazyExpired.code)).toBeUndefined();
    expect(store.getGrant(lazyExpired.grant.grantId)?.revokedAtMs).toBeUndefined();

    const swept = createGrant(store, { expiresAtMs: now + 10 });
    now += 11;
    await vi.advanceTimersByTimeAsync(25);

    expect(store.getGrant(swept.grant.grantId)?.revokedAtMs).toBe(now);
    expect(store.findRedeemableGrant(swept.code)).toBeUndefined();
  });

  it("W0-T5 security: serialized store file contains neither the plaintext code nor any plaintext token", () => {
    const now = 1_800_000_000_000;
    const { store } = makeStore({ now: () => now });
    const created = createGrant(store, { expiresAtMs: now + 60_000 });
    const plaintextToken = "guest-connection-token-plaintext-canary";
    const join = store.createJoin({ grantId: created.grant.grantId, token: plaintextToken });

    expect(created.grant.codeHash).not.toBe(created.code);
    expect(join.tokenHash).not.toBe(plaintextToken);
    store.close();
    closeOpenClawStateDatabaseForTest();

    const databaseDir = path.dirname(store.filePath);
    const serialized = fs
      .readdirSync(databaseDir)
      .filter((entry) => entry.startsWith(path.basename(store.filePath)))
      .map((entry) => fs.readFileSync(path.join(databaseDir, entry)).toString("latin1"))
      .join("\n");
    expect(serialized).not.toContain(created.code);
    expect(serialized).not.toContain(plaintextToken);
  });

  it("W0-T6 unit: two joins on one grant get guest:<grantId>:1 and :2 with Guest 1/Guest 2", () => {
    const now = 1_800_000_000_000;
    const { store } = makeStore({ now: () => now });
    const created = createGrant(store, { expiresAtMs: now + 60_000 });

    const first = store.createJoin({ grantId: created.grant.grantId, token: "token-one" });
    const second = store.createJoin({ grantId: created.grant.grantId, token: "token-two" });

    expect(first).toMatchObject({
      guestId: `guest:${created.grant.grantId}:1`,
      displayName: "Guest 1",
    });
    expect(second).toMatchObject({
      guestId: `guest:${created.grant.grantId}:2`,
      displayName: "Guest 2",
    });
    expect(store.listJoins(created.grant.grantId)).toEqual([first, second]);
  });
});
