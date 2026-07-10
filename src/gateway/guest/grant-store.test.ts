import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { GuestGrantStore, type GuestGrant } from "./grant-store.js";

const SHARE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/;

describe("GuestGrantStore", () => {
  const tempDirs: string[] = [];
  const stores: GuestGrantStore[] = [];

  function makeStateDir(label = "openclaw-guest-grants-") {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), label));
    tempDirs.push(stateDir);
    return stateDir;
  }

  function trackStore(store: GuestGrantStore): GuestGrantStore {
    stores.push(store);
    return store;
  }

  function makeStore(options: { now?: () => number; sweepIntervalMs?: number } = {}) {
    const stateDir = makeStateDir();
    const store = trackStore(new GuestGrantStore({ stateDir, ...options }));
    return { stateDir, store };
  }

  function readSerializedStore(filePath: string): string {
    const databaseDir = path.dirname(filePath);
    return fs
      .readdirSync(databaseDir)
      .filter((entry) => entry.startsWith(path.basename(filePath)))
      .map((entry) => fs.readFileSync(path.join(databaseDir, entry)).toString("latin1"))
      .join("\n");
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

    const serialized = readSerializedStore(store.filePath);
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

    const invited = store.createGrant({
      sessionKey: "agent:main:guest-demo",
      audience: "deva-user",
      invitedPrincipal: { issuer: "deva", subject: "deva-user-42" },
      createdBy: "device:test-host",
      expiresAtMs: now + 60_000,
    });
    expect(() =>
      store.createJoin({ grantId: invited.grant.grantId, token: "missing-principal" }),
    ).toThrow("guest identity does not match invite");
    expect(() =>
      store.createJoin({
        grantId: invited.grant.grantId,
        token: "wrong-principal",
        devaUserId: "deva-user-7",
      }),
    ).toThrow("guest identity does not match invite");
    expect(
      store.createJoin({
        grantId: invited.grant.grantId,
        token: "matching-principal",
        devaUserId: "deva-user-42",
      }),
    ).toMatchObject({ devaUserId: "deva-user-42", displayName: "Guest 1" });

    const capped = store.createGrant({
      sessionKey: "agent:main:guest-demo",
      audience: "open",
      createdBy: "device:test-host",
      expiresAtMs: now + 60_000,
      maxConcurrentGuests: 1,
    });
    store.createJoin({ grantId: capped.grant.grantId, token: "capped-one" });
    expect(() => store.createJoin({ grantId: capped.grant.grantId, token: "capped-two" })).toThrow(
      "guest grant has reached its guest limit",
    );
  });

  it("W0-T9 integration: restart preserves active, revoked, and expired grants without reusing guest ordinals", () => {
    const startedAtMs = 1_800_000_000_000;
    let now = startedAtMs;
    const { stateDir, store } = makeStore({ now: () => now });
    const active = createGrant(store, { expiresAtMs: startedAtMs + 60_000 });
    const revoked = createGrant(store, { expiresAtMs: startedAtMs + 60_000 });
    const expired = createGrant(store, { expiresAtMs: startedAtMs + 100 });
    const firstJoin = store.createJoin({ grantId: active.grant.grantId, token: "ordinal-one" });
    expect(firstJoin.displayName).toBe("Guest 1");
    expect(store.revokeGrant(revoked.grant.grantId)?.revokedAtMs).toBe(startedAtMs);

    now = startedAtMs + 101;
    store.close();
    closeOpenClawStateDatabaseForTest();

    const reloaded = trackStore(new GuestGrantStore({ stateDir, now: () => now }));
    expect(reloaded.getGrant(active.grant.grantId)?.revokedAtMs).toBeUndefined();
    expect(reloaded.getGrant(revoked.grant.grantId)?.revokedAtMs).toBe(startedAtMs);
    expect(reloaded.getGrant(expired.grant.grantId)?.expiresAtMs).toBe(startedAtMs + 100);
    expect(reloaded.findRedeemableGrant(expired.code)).toBeUndefined();
    expect(
      reloaded.createJoin({ grantId: active.grant.grantId, token: "ordinal-two" }),
    ).toMatchObject({
      guestId: `guest:${active.grant.grantId}:2`,
      displayName: "Guest 2",
    });
    expect(reloaded.sweepExpired()).toBe(1);

    reloaded.close();
    closeOpenClawStateDatabaseForTest();
    const reloadedAgain = trackStore(new GuestGrantStore({ stateDir, now: () => now }));
    expect(reloadedAgain.getGrant(expired.grant.grantId)?.revokedAtMs).toBe(now);
    expect(
      reloadedAgain.createJoin({ grantId: active.grant.grantId, token: "ordinal-three" }),
    ).toMatchObject({
      guestId: `guest:${active.grant.grantId}:3`,
      displayName: "Guest 3",
    });
  });

  it("W0-T10 unit: concurrent grant and join minting stays unique and leaves an atomic readable store", async () => {
    const now = 1_800_000_000_000;
    const { stateDir, store } = makeStore({ now: () => now });
    const joinGrant = createGrant(store, { expiresAtMs: now + 60_000 });
    const grantCount = 16;
    const joinCount = 24;

    const results = await Promise.all([
      ...Array.from({ length: grantCount }, (_, index) =>
        Promise.resolve().then(() => ({
          kind: "grant" as const,
          value: store.createGrant({
            sessionKey: `agent:main:race-${index}`,
            audience: "open",
            createdBy: "device:race-test",
            expiresAtMs: now + 60_000,
          }),
        })),
      ),
      ...Array.from({ length: joinCount }, (_, index) =>
        Promise.resolve().then(() => ({
          kind: "join" as const,
          value: store.createJoin({
            grantId: joinGrant.grant.grantId,
            token: `join-race-token-${index}`,
          }),
        })),
      ),
    ]);
    const grants = results
      .filter((result) => result.kind === "grant")
      .map((result) => result.value);
    const joins = results.filter((result) => result.kind === "join").map((result) => result.value);

    expect(new Set(grants.map((entry) => entry.grant.grantId)).size).toBe(grantCount);
    expect(new Set(grants.map((entry) => entry.code)).size).toBe(grantCount);
    expect(joins.map((entry) => entry.displayName).toSorted()).toEqual(
      Array.from({ length: joinCount }, (_, index) => `Guest ${index + 1}`).toSorted(),
    );
    expect(new Set(joins.map((entry) => entry.guestId)).size).toBe(joinCount);

    store.close();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(store.filePath, { readOnly: true });
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();

    const reloaded = trackStore(new GuestGrantStore({ stateDir, now: () => now }));
    expect(reloaded.listGrants()).toHaveLength(grantCount + 1);
    expect(reloaded.listJoins(joinGrant.grant.grantId)).toHaveLength(joinCount);
  });

  it("W0-T11 unit: corrupt stores fail closed and interrupted writes cannot resurrect revocation tombstones", () => {
    const now = 1_800_000_000_000;
    const { stateDir, store } = makeStore({ now: () => now });
    const created = createGrant(store, { expiresAtMs: now + 60_000 });
    expect(store.revokeGrant(created.grant.grantId)?.revokedAtMs).toBe(now);
    store.close();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const interrupted = new DatabaseSync(store.filePath);
    interrupted.exec("BEGIN IMMEDIATE;");
    interrupted
      .prepare("UPDATE guest_grants SET revoked_at_ms = NULL WHERE grant_id = ?")
      .run(created.grant.grantId);
    interrupted.close();

    const recovered = trackStore(new GuestGrantStore({ stateDir, now: () => now }));
    expect(recovered.getGrant(created.grant.grantId)?.revokedAtMs).toBe(now);
    expect(recovered.findRedeemableGrant(created.code)).toBeUndefined();
    recovered.close();
    closeOpenClawStateDatabaseForTest();

    const malformedStateDir = makeStateDir("openclaw-guest-malformed-");
    const malformedPath = path.join(malformedStateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
    const malformedBytes = Buffer.from("not a sqlite guest grant store", "utf8");
    fs.writeFileSync(malformedPath, malformedBytes);
    expect(() => new GuestGrantStore({ stateDir: malformedStateDir })).toThrow();
    expect(fs.readFileSync(malformedPath)).toEqual(malformedBytes);

    const truncatedStateDir = makeStateDir("openclaw-guest-truncated-");
    const truncatedPath = path.join(truncatedStateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(truncatedPath), { recursive: true });
    const durableBytes = fs.readFileSync(store.filePath);
    const truncatedBytes = durableBytes.subarray(0, Math.min(128, durableBytes.length - 1));
    fs.writeFileSync(truncatedPath, truncatedBytes);
    expect(() => new GuestGrantStore({ stateDir: truncatedStateDir })).toThrow();
    expect(fs.readFileSync(truncatedPath)).toEqual(truncatedBytes);

    const finalReload = trackStore(new GuestGrantStore({ stateDir, now: () => now }));
    expect(finalReload.getGrant(created.grant.grantId)?.revokedAtMs).toBe(now);
  });

  it("W0-T12 unit: share-code alphabet and length are pinned and collisions retry with fresh entropy", () => {
    const now = 1_800_000_000_000;
    const stateDir = makeStateDir();
    const entropy = [Buffer.alloc(6, 0), Buffer.alloc(6, 0), Buffer.alloc(6, 31)];
    const randomBytes = vi.fn((size: number) => {
      expect(size).toBe(6);
      const bytes = entropy.shift();
      if (!bytes) {
        throw new Error("unexpected entropy request");
      }
      return bytes;
    });
    const options = { stateDir, now: () => now, randomBytes };
    const store = trackStore(new GuestGrantStore(options));

    const first = createGrant(store, { expiresAtMs: now + 60_000 });
    const second = createGrant(store, { expiresAtMs: now + 60_000 });

    expect(first.code).toBe("AAA-AAA");
    expect(second.code).toBe("999-999");
    expect([first.code, second.code]).toEqual([
      expect.stringMatching(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/),
      expect.stringMatching(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/),
    ]);
    expect(`${first.code}${second.code}`).not.toMatch(/[01OI]/u);
    expect(randomBytes).toHaveBeenCalledTimes(3);
  });

  it("W0-T14 security: serialized grants contain no share URL, plaintext code, connection token, or token-bearing JSON field", () => {
    const now = 1_800_000_000_000;
    const { store } = makeStore({ now: () => now });
    const created = createGrant(store, { expiresAtMs: now + 60_000 });
    const joinUrl = `https://joins.example.test/invite/${created.code}`;
    const connectionTokens = [
      "oc-guest-connection-token-plaintext",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJndWVzdCI6dHJ1ZX0.signature",
      "connectionToken=guest-secret-123456789",
    ];
    for (const token of connectionTokens) {
      store.createJoin({ grantId: created.grant.grantId, token });
    }

    store.close();
    closeOpenClawStateDatabaseForTest();
    const serialized = readSerializedStore(store.filePath);

    expect(serialized).not.toContain(created.code);
    expect(serialized).not.toContain(joinUrl);
    for (const token of connectionTokens) {
      expect(serialized).not.toContain(token);
    }
    expect(serialized).not.toMatch(/"(?:token|connectionToken|code|joinUrl)"\s*:\s*"[^"]+"/iu);
  });
});
