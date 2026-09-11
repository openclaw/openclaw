import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { loadPairedDevicePairingStoreRecordFromDatabase } from "./device-pairing-store.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { loadApnsRegistration, registerApnsRegistration } from "./push-apns-store.js";
import {
  LiveActivityStore,
  type LiveActivityDeliveryOwner,
  type LiveActivityOwnerIsCurrent,
} from "./push-live-activity-store.js";
import {
  createLiveActivityStoreFixture,
  destination,
  isCurrent,
  isReady,
  relay,
  TABLE,
  value,
} from "./push-live-activity-store.test-support.js";

const tempDirs = createTrackedTempDirs();
const extraConnections: DatabaseSync[] = [];
const EPOCH = 1_800_000_000_000;
const HOUR = 3_600_000;
const ATTEMPT_TIMEOUT_MS = 10_000;
let now = EPOCH;

async function fixture(pair = true) {
  const dir = await tempDirs.make("openclaw-live-activity-store-");
  return createLiveActivityStoreFixture(dir, () => now, pair);
}

beforeEach(() => {
  now = EPOCH;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(async () => {
  for (const db of extraConnections.splice(0)) {
    db.close();
  }
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

describe("Live Activity store", () => {
  it("leaves unused state absent and installs the canonical table and indexes only on registration", async () => {
    const f = await fixture(false);
    expect(f.store.loadByActivity("gateway-1", "node-1", "activity-1")).toBeNull();
    expect(existsSync(path.dirname(f.options.path))).toBe(false);
    expect(f.store.load("missing")).toBeNull();
    expect(f.store.list("gateway-1")).toEqual([]);
    expect(f.store.nextMaintenanceAtMs()).toBeNull();
    expect(f.store.sweep()).toEqual({ ok: true, value: 0 });
    expect(f.store.retireOwner(f.input.binding)).toEqual({ ok: true, value: 0 });
    expect(f.store.revoke({ registrationId: "missing", expectedRevision: 1 }, isCurrent)).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(existsSync(f.options.path)).toBe(false);
    f.persistPairing([f.device]);
    const { db } = openOpenClawStateDatabase(f.options);
    expect(tableExists(db, TABLE)).toBe(false);
    expect(f.store.loadByActivity("gateway-1", "node-1", "activity-1")).toBeNull();
    expect(f.store.nextMaintenanceAtMs()).toBeNull();
    f.store.sweep();
    expect(tableExists(db, TABLE)).toBe(false);
    const before = db.prepare("PRAGMA user_version").get();
    f.saved();
    expect(f.store.nextMaintenanceAtMs()).toBe(EPOCH + 8 * HOUR);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(before);
    expect(before).toEqual({ user_version: 17 });
    expect(db.prepare("SELECT strict FROM pragma_table_list WHERE name = ?").get(TABLE)).toEqual({
      strict: 1,
    });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE tbl_name = ? AND sql LIKE 'CREATE INDEX%' ORDER BY name",
        )
        .all(TABLE),
    ).toEqual([
      { name: "idx_apns_live_activities_device" },
      { name: "idx_apns_live_activities_expiry" },
    ]);
  });

  it("replays exact registration without extending its lease and rejects owner or destination conflicts", async () => {
    const f = await fixture();
    const saved = f.saved();
    const { gatewayId, deviceId } = saved.binding;
    expect(f.store.loadByActivity(gatewayId, deviceId, saved.activityId)).toEqual(saved);
    for (const [candidateGatewayId, candidateDeviceId, candidateActivityId] of [
      ["other-gateway", deviceId, saved.activityId],
      [gatewayId, "other-node", saved.activityId],
      [gatewayId, deviceId, "other-activity"],
    ] as const) {
      expect(
        f.store.loadByActivity(candidateGatewayId, candidateDeviceId, candidateActivityId),
      ).toBeNull();
    }
    now += HOUR;
    expect(f.saved()).toEqual(saved);
    expect(saved.leaseExpiresAtMs).toBe(EPOCH + 8 * HOUR);
    for (const binding of [
      { ...f.input.binding, publicRunId: "other-run" },
      { ...f.input.binding, profileId: "other-profile" },
      { ...f.input.binding, sessionId: "other-session" },
      { ...f.input.binding, lifecycleRevision: "opaque-generation" },
    ]) {
      expect(f.store.register({ ...f.input, binding }, isCurrent)).toEqual({
        ok: false,
        error: "binding-conflict",
      });
    }
    expect(
      f.store.register(
        { ...f.input, destination: { ...destination, token: "b".repeat(64) } },
        isCurrent,
      ),
    ).toEqual({ ok: false, error: "revision-conflict" });
    expect(f.store.load(saved.registrationId)).toEqual(saved);
    const scalar = "\u{1f4a1}";
    const binding = {
      ...f.input.binding,
      sessionKey: scalar.repeat(512),
      sessionId: scalar.repeat(128),
      publicRunId: scalar.repeat(256),
    };
    const bounded = f.saved({ activityId: "scalar-boundary", binding });
    expect(f.store.load(bounded.registrationId)?.binding).toEqual(binding);
    for (const invalid of [
      { sessionKey: scalar.repeat(513) },
      { sessionId: scalar.repeat(129) },
      { publicRunId: scalar.repeat(257) },
      { sessionId: "generation\u0000" },
      { sessionId: "\ud800" },
    ]) {
      expect(
        f.store.register(
          {
            ...f.input,
            activityId: "invalid-boundary",
            binding: {
              ...binding,
              ...invalid,
            },
          },
          isCurrent,
        ),
      ).toEqual({ ok: false, error: "invalid-input" });
    }
  });

  it("preserves ordinary APNs registration while direct and relay Activities retire independently", async () => {
    const f = await fixture();
    const ordinary = await registerApnsRegistration({
      nodeId: f.device.deviceId,
      token: "c".repeat(64),
      topic: destination.topic,
      environment: "sandbox",
      baseDir: f.dir,
    });
    const direct = f.saved();
    const relayed = f.saved({ activityId: "relayed-activity", destination: relay });
    value(
      f.store.revoke({ registrationId: direct.registrationId, expectedRevision: 1 }, isCurrent),
    );
    expect(f.row(direct.registrationId).destination_json).toBeNull();
    expect(JSON.parse(f.row(relayed.registrationId).destination_json!)).toEqual(relay);
    expect(await loadApnsRegistration(f.device.deviceId, f.dir)).toEqual(ordinary);
  });

  it("fences rotated claims, late responses, and stale revocations with the exact destination revision", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const old = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(f.store.authorizeDispatch(old, isReady));
    now += 100;
    const rotated = value(
      f.store.rotate(
        {
          registrationId: saved.registrationId,
          expectedRevision: 1,
          destination: { ...destination, token: "b".repeat(64) },
        },
        isCurrent,
      ),
    );
    expect(rotated.rotationRevision).toBe(2);
    expect(rotated.leaseExpiresAtMs).toBe(saved.leaseExpiresAtMs);
    expect(f.store.settle(old, "permanent")).toEqual({ ok: false, error: "stale-claim" });
    expect(
      f.store.revoke({ registrationId: saved.registrationId, expectedRevision: 1 }, isCurrent),
    ).toEqual({ ok: false, error: "revision-conflict" });
    expect(
      f.store.rotate(
        { registrationId: saved.registrationId, expectedRevision: 1, destination },
        isCurrent,
      ),
    ).toEqual({ ok: false, error: "revision-conflict" });
    now = EPOCH + 5_000;
    const fresh = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(fresh.destination).toMatchObject({ token: "b".repeat(64) });
    value(f.store.authorizeDispatch(fresh, isReady));
    value(f.store.settle(fresh, "accepted"));
    expect(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "not-due",
    });
  });

  it("keeps relay installation, topic, environment, and origin immutable through rotation", async () => {
    const f = await fixture();
    const saved = f.saved({ destination: relay });
    for (const patch of [
      { installationId: "other-install" },
      { topic: "ai.other.app" },
      { environment: "production" as const },
      { relayOrigin: "https://other.example" },
      { relayRevision: 1 },
    ]) {
      expect(
        f.store.rotate(
          {
            registrationId: saved.registrationId,
            expectedRevision: 1,
            destination: { ...relay, relayRevision: 2, relayHandle: "rotated", ...patch },
          },
          isCurrent,
        ),
      ).toEqual({ ok: false, error: "binding-conflict" });
    }
    const next = value(
      f.store.rotate(
        {
          registrationId: saved.registrationId,
          expectedRevision: 1,
          destination: {
            ...relay,
            relayRevision: 2,
            relayHandle: "rotated",
            sendGrant: "rotated-grant",
          },
        },
        isCurrent,
      ),
    );
    expect(next.rotationRevision).toBe(2);
  });

  it("orders source facts independently of token revisions and never adopts a different source implicitly", async () => {
    const f = await fixture();
    const saved = f.saved();
    const first = f.observe(saved.registrationId, { sequence: 10 });
    expect(f.observe(saved.registrationId, { sequence: 10 })).toEqual(first);
    for (const patch of [
      { sequence: 1 },
      { sequence: 10, status: "toolRunning" as const },
      { sequence: 11, observedAtMs: now - 1 },
    ]) {
      expect(f.store.observe(saved.registrationId, f.fact(patch), isCurrent)).toEqual({
        ok: false,
        error: "out-of-order",
      });
    }
    expect(
      f.store.observe(
        saved.registrationId,
        f.fact({ sourceIncarnation: "restarted-owner", sequence: 500 }),
        isCurrent,
      ),
    ).toEqual({ ok: false, error: "source-changed" });
    expect(f.store.load(saved.registrationId)).toEqual(first);
  });

  it.each([undefined, Number.MAX_SAFE_INTEGER])(
    "commits terminal closure with progress watermark %s and absorbs later facts",
    async (sequence) => {
      const f = await fixture();
      const saved = f.saved();
      const progress =
        sequence === undefined
          ? undefined
          : f.observe(saved.registrationId, { sequence, status: "toolRunning" });
      const old = progress
        ? value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS))
        : undefined;
      if (old) {
        value(f.store.authorizeDispatch(old, isReady));
      }
      now += 200;
      const terminal = f.observe(saved.registrationId, { status: "done", endedAtMs: now });
      expect(terminal.snapshot).toEqual({
        sourceIncarnation: saved.sourceIncarnation,
        sequence: sequence ?? 0,
        status: "done",
        observedAtMs: now,
        endedAtMs: now,
      });
      expect(terminal.deliveryRevision).toBe((progress?.deliveryRevision ?? 0) + 1);
      expect(terminal.terminalDeadlineMs).toBe(now + 300_000);
      const frozen = f.row(saved.registrationId);
      expect(frozen).toMatchObject({
        state: "terminal_pending",
        claim_id: null,
        claim_runtime_id: null,
        claim_deadline_ms: null,
        claim_authorized_at_ms: null,
        delivery_timestamp_s: null,
        last_dispatch_timestamp_s: old?.timestampSeconds ?? null,
      });
      if (old) {
        expect(f.store.settle(old, "permanent")).toEqual({ ok: false, error: "stale-claim" });
      }
      now += 10_000;
      expect(f.observe(saved.registrationId, { sequence: 1, status: "toolRunning" })).toEqual(
        terminal,
      );
      expect(f.observe(saved.registrationId, { status: "failed" })).toEqual(terminal);
      expect(f.row(saved.registrationId)).toEqual(frozen);
      expect(frozen.destination_json).not.toBeNull();
    },
  );

  it("bounds the encoded snapshot in UTF-8 bytes and refuses extra or impossible fact fields", async () => {
    const f = await fixture();
    const sourceIncarnation = "a".repeat(900);
    const ascii = f.saved({ sourceIncarnation });
    expect(f.store.observe(ascii.registrationId, f.fact({ sourceIncarnation }), isCurrent).ok).toBe(
      true,
    );
    const wideSource = "\u754c".repeat(900);
    const wide = f.saved({ activityId: "wide", sourceIncarnation: wideSource });
    expect(
      f.store.observe(wide.registrationId, f.fact({ sourceIncarnation: wideSource }), isCurrent),
    ).toEqual({ ok: false, error: "snapshot-too-large" });
    const extra = { ...f.fact(), detail: "must not persist arbitrary content" };
    expect(f.store.observe(ascii.registrationId, extra, isCurrent)).toEqual({
      ok: false,
      error: "invalid-input",
    });
    for (const fact of [
      f.fact({ startedAtMs: now + 1 }),
      f.fact({ status: "done", endedAtMs: now + 1 }),
      f.fact({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
      f.fact({ sequence: 1.5 }),
      f.fact({ observedAtMs: now + 1 }),
      f.fact({ observedAtMs: -0.25 }),
      f.fact({ observedAtMs: Number.NaN }),
      f.fact({ observedAtMs: Infinity }),
      f.fact({ observedAtMs: Number.MAX_SAFE_INTEGER + 1 }),
      { ...f.fact({ status: "done" }), sequence: 1 },
    ]) {
      expect(
        f.store.observe(ascii.registrationId, { ...fact, sourceIncarnation }, isCurrent),
      ).toEqual({ ok: false, error: "invalid-input" });
    }
    expect(f.row(wide.registrationId).snapshot_json).toBeNull();
    now += 1;
    const fractional = f.fact({
      sourceIncarnation,
      status: "done",
      observedAtMs: EPOCH + 0.75,
      startedAtMs: EPOCH - 0.125,
      endedAtMs: EPOCH + 0.5,
    });
    const accepted = value(f.store.observe(ascii.registrationId, fractional, isCurrent));
    expect(accepted.snapshot).toEqual({ ...fractional, sequence: 1 });
    expect(JSON.parse(f.row(ascii.registrationId).snapshot_json!)).toEqual({
      ...fractional,
      sequence: 1,
    });
    expect(accepted.terminalDeadlineMs).toBe(EPOCH + 300_000);
  });

  it("requires exact one-shot local claims and rejects asynchronous authority at both boundaries", async () => {
    expectTypeOf<() => Promise<"ready">>().not.toExtend<
      Parameters<LiveActivityStore["authorizeDispatch"]>[1]
    >();
    expectTypeOf<() => boolean>().not.toExtend<Parameters<LiveActivityStore["claim"]>[1]>();
    expectTypeOf<() => Promise<"ready">>().not.toExtend<
      Parameters<LiveActivityStore["claim"]>[1]
    >();
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(f.store.authorizeDispatch({ ...claim }, isReady)).toEqual({
      ok: false,
      error: "stale-claim",
    });
    value(f.store.authorizeDispatch(claim, isReady));
    expect(f.store.authorizeDispatch(claim, isReady)).toEqual({
      ok: false,
      error: "stale-claim",
    });
    value(f.store.settle(claim, "accepted"));
    expect(f.store.settle(claim, "accepted")).toEqual({ ok: false, error: "stale-claim" });
    now += 5_000;
    f.observe(saved.registrationId, { sequence: 2 });
    const next = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    // JavaScript callers cannot turn a Promise into synchronous SQLite authority.
    expect(
      Reflect.apply(f.store.authorizeDispatch.bind(f.store), undefined, [
        next,
        async () => "ready",
      ]),
    ).toEqual({
      ok: false,
      error: "owner-changed",
    });
    expect(f.row(saved.registrationId).destination_json).toBeNull();
    for (const [index, owner] of [() => true, async () => "ready"].entries()) {
      const invalid = f.saved({ activityId: `invalid-${index}` });
      f.observe(invalid.registrationId);
      expect(
        Reflect.apply(f.store.claim.bind(f.store), undefined, [
          invalid.registrationId,
          owner,
          ATTEMPT_TIMEOUT_MS,
        ]),
      ).toEqual({
        ok: false,
        error: "owner-changed",
      });
      expect(f.row(invalid.registrationId).destination_json).toBeNull();
    }
  });

  it("holds delivery without changing state or consuming a prepared claim, then resumes it", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const before = f.row(saved.registrationId);
    expect(f.store.claim(saved.registrationId, () => "held", ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "not-due",
    });
    expect(f.row(saved.registrationId)).toEqual(before);
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    const prepared = f.row(saved.registrationId);
    expect(f.store.authorizeDispatch(claim, () => "held")).toEqual({
      ok: false,
      error: "not-due",
    });
    expect(f.store.settle(claim, "permanent")).toEqual({ ok: false, error: "stale-claim" });
    expect(f.row(saved.registrationId)).toEqual(prepared);
    value(f.store.authorizeDispatch(claim, isReady));
    value(f.store.settle(claim, "accepted"));
    expect(f.row(saved.registrationId).state).toBe("active");
    expect(f.row(saved.registrationId).destination_json).toBe(before.destination_json);
  });

  it("rechecks callback re-entry without retiring or authorizing the replacement token", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(
      f.store.authorizeDispatch(claim, () => {
        value(
          f.store.rotate(
            {
              registrationId: saved.registrationId,
              expectedRevision: 1,
              destination: { ...destination, token: "b".repeat(64) },
            },
            isCurrent,
          ),
        );
        return "held";
      }),
    ).toEqual({ ok: false, error: "revision-conflict" });
    expect(f.row(saved.registrationId)).toMatchObject({
      state: "active",
      rotation_revision: 2,
      claim_id: null,
      claim_authorized_at_ms: null,
    });
    expect(JSON.parse(f.row(saved.registrationId).destination_json!)).toMatchObject({
      token: "b".repeat(64),
    });
  });

  it("reads uncommitted owner revocation through the dispatch transaction's borrowed handle", async () => {
    const f = await fixture();
    const operator = {
      token: "test-operator-token",
      role: "operator",
      scopes: ["operator.write"],
      createdAtMs: 100,
    };
    const device = {
      ...f.device,
      roles: ["node", "operator"],
      tokens: { ...f.device.tokens, operator },
    };
    f.persistPairing([device]);
    const canWrite: LiveActivityOwnerIsCurrent = (binding, _source, db) =>
      loadPairedDevicePairingStoreRecordFromDatabase(
        db,
        binding.deviceId,
      )?.tokens?.operator?.scopes.includes("operator.write") === true;
    const saved = value(f.store.register(f.input, canWrite));
    f.observe(saved.registrationId);
    const deliveryOwner: LiveActivityDeliveryOwner = (binding, source, db) =>
      canWrite(binding, source, db) ? "ready" : "lost";
    const claim = value(f.store.claim(saved.registrationId, deliveryOwner, ATTEMPT_TIMEOUT_MS));
    runOpenClawStateWriteTransaction(({ db }) => {
      f.persistPairing([
        { ...device, tokens: { ...device.tokens, operator: { ...operator, scopes: [] } } },
      ]);
      expect(
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db: committed }) => canWrite(saved.binding, saved.sourceIncarnation, committed),
          f.options,
        ),
      ).toBe(true);
      let sameTransaction = false;
      let authorized: boolean | undefined;
      const result = f.store.authorizeDispatch(claim, (binding, source, ownerDb) => {
        sameTransaction = ownerDb === db && ownerDb.isTransaction;
        authorized = canWrite(binding, source, ownerDb);
        return authorized ? "ready" : "lost";
      });
      expect(sameTransaction).toBe(true);
      expect(authorized).toBe(false);
      expect(result).toEqual({ ok: false, error: "owner-changed" });
    }, f.options);
    expect(f.row(saved.registrationId)).toMatchObject({
      state: "tombstone",
      claim_authorized_at_ms: null,
      destination_json: null,
    });
  });

  it("closes retained claims when the store lifecycle closes during admission", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(
      f.store.authorizeDispatch(claim, () => {
        f.store.close();
        return "ready";
      }),
    ).toEqual({ ok: false, error: "closed" });
    expect(f.row(saved.registrationId).claim_authorized_at_ms).toBeNull();
    expect(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "closed",
    });
  });

  it("preserves rows across pairing rewrites but rechecks the node-owned generation before sending", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    f.persistPairing([{ ...f.device, approvedAtMs: 999 }]);
    expect(f.store.load(saved.registrationId)).not.toBeNull();
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    f.persistPairing([{ ...f.device, publicKey: "replacement-public-key" }]);
    expect(f.store.authorizeDispatch(claim, () => "held")).toEqual({
      ok: false,
      error: "owner-changed",
    });
    expect(f.row(saved.registrationId)).toMatchObject({
      state: "tombstone",
      destination_json: null,
      snapshot_json: null,
      claim_id: null,
    });
  });

  it("rejects noncanonical device identity instead of creating an alternate device quota bucket", async () => {
    const f = await fixture();
    expect(
      f.store.register(
        {
          ...f.input,
          binding: {
            ...f.input.binding,
            deviceId: ` ${f.device.deviceId} `,
          },
        },
        isCurrent,
      ),
    ).toEqual({ ok: false, error: "owner-changed" });
    expect(f.store.list("gateway-1")).toEqual([]);
  });

  it("rechecks the lease after synchronous authority evaluation", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(
      f.store.authorizeDispatch(claim, () => {
        now = saved.leaseExpiresAtMs;
        return "held";
      }),
    ).toEqual({ ok: false, error: "retired" });
    expect(f.row(saved.registrationId).destination_json).toBeNull();
  });

  it("retires only the exact session lifecycle owner and rejects removed profile authority", async () => {
    const f = await fixture();
    const original = f.saved();
    const successorBinding = { ...f.input.binding, lifecycleRevision: "new-incarnation" };
    const successor = f.saved({ activityId: "successor", binding: successorBinding });
    value(f.store.retireOwner(f.input.binding));
    expect(f.row(original.registrationId).state).toBe("tombstone");
    expect(f.row(successor.registrationId).state).toBe("active");
    f.observe(successor.registrationId);
    const claim = value(f.store.claim(successor.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(f.store.authorizeDispatch(claim, () => "lost")).toEqual({
      ok: false,
      error: "owner-changed",
    });
    expect(f.row(successor.registrationId).destination_json).toBeNull();
  });

  it("coalesces progress, lets terminal facts bypass progress delay, and erases credentials after accepted end", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const progress = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(f.store.authorizeDispatch(progress, isReady));
    value(f.store.settle(progress, "transient"));
    now += 1_000;
    f.observe(saved.registrationId, { sequence: 2, status: "toolRunning" });
    expect(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "not-due",
    });
    f.observe(saved.registrationId, { status: "done" });
    const end = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(f.store.authorizeDispatch(end, isReady));
    value(f.store.settle(end, "accepted"));
    expect(f.row(saved.registrationId)).toMatchObject({
      state: "tombstone",
      destination_json: null,
      snapshot_json: null,
      claim_id: null,
      claim_runtime_id: null,
      next_attempt_at_ms: null,
      retirement_reason: "terminal-delivered",
      tombstone_expires_at_ms: now + 24 * HOUR,
    });
  });

  it("bounds terminal retries by the earlier original lease or first terminal deadline", async () => {
    const f = await fixture();
    const saved = f.saved();
    now = saved.leaseExpiresAtMs - 60_000;
    const terminal = f.observe(saved.registrationId, { status: "timeout" });
    expect(terminal.terminalDeadlineMs).toBe(saved.leaseExpiresAtMs);
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(f.store.authorizeDispatch(claim, isReady));
    value(f.store.settle(claim, "transient"));
    now += 5_000;
    const retry = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(retry.registration.terminalDeadlineMs).toBe(terminal.terminalDeadlineMs);
    now = saved.leaseExpiresAtMs;
    expect(f.store.authorizeDispatch(retry, isReady)).toEqual({ ok: false, error: "retired" });
    expect(f.row(saved.registrationId).destination_json).toBeNull();
  });

  it("waits for the next real APNs second and reuses the reserved timestamp on terminal retries", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const progress = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(progress.timestampSeconds).toBe(Math.floor(now / 1_000));
    value(f.store.authorizeDispatch(progress, isReady));
    value(f.store.settle(progress, "accepted"));
    now += 200;
    f.observe(saved.registrationId, { status: "done", endedAtMs: now });
    expect(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "not-due",
    });
    expect(f.row(saved.registrationId)).toMatchObject({
      delivery_timestamp_s: null,
      last_dispatch_timestamp_s: EPOCH / 1_000,
      next_attempt_at_ms: EPOCH + 1_000,
    });
    now = EPOCH + 1_000;
    const end = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(end.timestampSeconds).toBe(now / 1_000);
    value(f.store.authorizeDispatch(end, isReady));
    value(f.store.settle(end, "transient"));
    now += 5_000;
    const retry = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(retry.timestampSeconds).toBe(end.timestampSeconds);
    expect(retry.snapshot).toEqual(end.snapshot);
    expect(retry.snapshot.observedAtMs).toBe(EPOCH + 200);
  });

  it("retires late terminal facts immediately instead of starting a new retry window at arrival", async () => {
    const f = await fixture();
    const saved = f.saved();
    now += 600_000;
    const retired = f.observe(saved.registrationId, { status: "done", observedAtMs: EPOCH });
    expect(retired.state).toBe("tombstone");
    expect(f.row(saved.registrationId)).toMatchObject({
      retired_at_ms: EPOCH + 300_000,
      tombstone_expires_at_ms: EPOCH + 300_000 + 24 * HOUR,
      destination_json: null,
      snapshot_json: null,
    });
  });

  it("hides expired tombstones without sweeping and never lets an old registration ID mutate its replacement", async () => {
    const f = await fixture();
    const saved = f.saved();
    const lookup = () =>
      f.store.loadByActivity(saved.binding.gatewayId, saved.binding.deviceId, saved.activityId);
    const sibling = f.saved({
      binding: { ...f.input.binding, gatewayId: "other-gateway" },
    });
    expect(
      f.store.loadByActivity("other-gateway", sibling.binding.deviceId, sibling.activityId),
    ).toEqual(sibling);
    expect(lookup()).toEqual(saved);
    f.observe(sibling.registrationId, { status: "done" });
    expect(f.store.nextMaintenanceAtMs()).toBe(EPOCH + 300_000);
    value(
      f.store.revoke({ registrationId: sibling.registrationId, expectedRevision: 1 }, isCurrent),
    );
    expect(f.store.nextMaintenanceAtMs()).toBe(EPOCH + 8 * HOUR);
    value(f.store.revoke({ registrationId: saved.registrationId, expectedRevision: 1 }, isCurrent));
    const tombstone = { ...saved, state: "tombstone" };
    expect(lookup()).toEqual(tombstone);
    expect(f.store.list("gateway-1")).toEqual([]);
    expect(f.store.nextMaintenanceAtMs()).toBe(EPOCH + 24 * HOUR);
    now += HOUR;
    expect(
      f.store.revoke({ registrationId: saved.registrationId, expectedRevision: 1 }, isCurrent),
    ).toEqual({ ok: true, value: false });
    expect(f.row(saved.registrationId).tombstone_expires_at_ms).toBe(EPOCH + 24 * HOUR);
    expect(lookup()).toEqual(tombstone);
    expect(f.store.register(f.input, isCurrent)).toEqual({ ok: false, error: "retired" });
    const retainedRow = f.row(saved.registrationId);
    now = EPOCH + 24 * HOUR + 1;
    expect(lookup()).toBeNull();
    expect(f.row(saved.registrationId)).toEqual(retainedRow);
    value(f.store.sweep());
    expect(f.store.nextMaintenanceAtMs()).toBeNull();
    expect(f.store.load(saved.registrationId)).toBeNull();
    expect(lookup()).toBeNull();
    const replacement = f.saved();
    expect(lookup()).toEqual(replacement);
    expect(f.store.nextMaintenanceAtMs()).toBe(now + 8 * HOUR);
    expect(replacement.registrationId).not.toBe(saved.registrationId);
    expect(
      f.store.revoke({ registrationId: saved.registrationId, expectedRevision: 1 }, isCurrent),
    ).toEqual({ ok: false, error: "not-found" });
  });

  it("limits sendable activities per device across gateways without evicting active destinations", async () => {
    const f = await fixture();
    for (let index = 0; index < 8; index++) {
      f.saved({ activityId: `activity-${index}` });
    }
    expect(f.store.register({ ...f.input, activityId: "ninth" }, isCurrent)).toEqual({
      ok: false,
      error: "capacity",
    });
    expect(
      f.store.register(
        { ...f.input, binding: { ...f.input.binding, gatewayId: "other-gateway" } },
        isCurrent,
      ),
    ).toEqual({ ok: false, error: "capacity" });
    expect(f.store.list("gateway-1")).toHaveLength(8);
  });

  it.each(["gateway", "total"] as const)(
    "enforces the %s row cap and prunes expired tombstones before capacity",
    async (scope) => {
      const f = await fixture();
      const saved = f.saved();
      if (scope === "total") {
        value(
          f.store.revoke({ registrationId: saved.registrationId, expectedRevision: 1 }, isCurrent),
        );
      }
      const template = f.row(saved.registrationId);
      const { db } = openOpenClawStateDatabase(f.options);
      const count = scope === "gateway" ? 256 : 4096;
      for (let start = 1; start < count; start += 200) {
        const batch: Array<Selectable<DB[typeof TABLE]>> = [];
        for (let index = start; index < Math.min(start + 200, count); index++) {
          batch.push({
            ...template,
            registration_id: `retained-${index}`,
            activity_id: `retained-${index}`,
            device_id: `retained-device-${index}`,
          });
        }
        executeSqliteQuerySync(db, getNodeSqliteKysely<DB>(db).insertInto(TABLE).values(batch));
      }
      expect(f.store.register({ ...f.input, activityId: "capacity-probe" }, isCurrent)).toEqual({
        ok: false,
        error: "capacity",
      });
      if (scope === "total") {
        now += 24 * HOUR;
        expect(f.saved({ activityId: "after-prune" }).state).toBe("active");
        expect(f.store.load(saved.registrationId)).toBeNull();
      }
    },
  );

  it.each(["rotation_revision", "delivery_revision", "dispatch_revision"] as const)(
    "never overflows %s",
    async (column) => {
      const f = await fixture();
      const saved = f.saved();
      f.observe(saved.registrationId);
      const { db } = openOpenClawStateDatabase(f.options);
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable(TABLE)
          .set({ [column]: Number.MAX_SAFE_INTEGER })
          .where("registration_id", "=", saved.registrationId),
      );
      const result =
        column === "rotation_revision"
          ? f.store.rotate(
              {
                registrationId: saved.registrationId,
                expectedRevision: Number.MAX_SAFE_INTEGER,
                destination: { ...destination, token: "b".repeat(64) },
              },
              isCurrent,
            )
          : column === "delivery_revision"
            ? f.store.observe(saved.registrationId, f.fact({ sequence: 2 }), isCurrent)
            : f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS);
      expect(result).toEqual({ ok: false, error: "revision-exhausted" });
      expect(f.row(saved.registrationId)[column]).toBe(Number.MAX_SAFE_INTEGER);
    },
  );

  it("serializes independent connections and fences the earlier attempt after a fresh retry claim", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const database = openOpenClawStateDatabase(f.options);
    const secondDb = openNodeSqliteDatabase(database.path);
    extraConnections.push(secondDb);
    const second = new LiveActivityStore({ ...f.options, database: { ...database, db: secondDb } });
    const first = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(second.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "not-due",
    });
    value(f.store.authorizeDispatch(first, isReady));
    now += 5_000;
    expect(second.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "not-due",
    });
    now = first.attemptDeadlineMs;
    const next = value(second.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(second.authorizeDispatch(next, isReady));
    expect(f.store.settle(first, "permanent")).toEqual({ ok: false, error: "stale-claim" });
    value(second.settle(next, "accepted"));
    expect(f.row(saved.registrationId).state).toBe("active");
  });

  it("reopens persisted state without restoring dispatch authority or claiming a restarted source is current", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const old = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    closeOpenClawStateDatabaseForTest();
    const reopened = new LiveActivityStore(f.options);
    expect(reopened.load(saved.registrationId)?.snapshot?.status).toBe("running");
    expect(reopened.authorizeDispatch(old, isReady)).toEqual({ ok: false, error: "stale-claim" });
    expect(f.store.authorizeDispatch(old, isReady)).toEqual({ ok: false, error: "stale-claim" });
    expect(
      reopened.observe(
        saved.registrationId,
        f.fact({ sourceIncarnation: "new-runtime", sequence: 100 }),
        isCurrent,
      ),
    ).toEqual({ ok: false, error: "source-changed" });
    now = old.attemptDeadlineMs;
    const fresh = value(reopened.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(reopened.authorizeDispatch(fresh, isReady));
    value(reopened.settle(fresh, "accepted"));
    now += 200;
    const terminal = value(
      reopened.observe(saved.registrationId, f.fact({ status: "done" }), isCurrent),
    );
    closeOpenClawStateDatabaseForTest();
    const terminalStore = new LiveActivityStore(f.options);
    expect(terminalStore.load(saved.registrationId)).toEqual(terminal);
    expect(terminal.snapshot).toMatchObject({ status: "done", sequence: 1, observedAtMs: now });
    expect(terminalStore.authorizeDispatch(fresh, isReady)).toEqual({
      ok: false,
      error: "stale-claim",
    });
    now += 1_000;
    const end = value(terminalStore.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(terminalStore.authorizeDispatch(end, isReady));
    value(terminalStore.settle(end, "accepted"));
    expect(f.row(saved.registrationId).destination_json).toBeNull();
  });

  it("fails closed on backwards wall time without synthesizing timestamps or extending deadlines", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const claim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    const before = f.row(saved.registrationId);
    now--;
    expect(f.store.authorizeDispatch(claim, isReady)).toEqual({
      ok: false,
      error: "clock-regressed",
    });
    expect(f.store.sweep()).toEqual({ ok: false, error: "clock-regressed" });
    expect(f.row(saved.registrationId)).toEqual(before);
  });

  it("rejects expired prepared claims and late settlement independently of the progress interval", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId);
    const prepared = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    now = EPOCH + ATTEMPT_TIMEOUT_MS;
    expect(f.store.authorizeDispatch(prepared, () => "held")).toEqual({
      ok: false,
      error: "stale-claim",
    });
    expect(prepared.attemptDeadlineMs).toBe(now);
    const next = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    value(f.store.authorizeDispatch(next, isReady));
    now += 5_000;
    expect(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS)).toEqual({
      ok: false,
      error: "not-due",
    });
    const before = f.row(saved.registrationId);
    now = next.attemptDeadlineMs;
    expect(f.store.settle(next, "permanent")).toEqual({ ok: false, error: "stale-claim" });
    expect(f.row(saved.registrationId)).toEqual(before);
    const retry = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(retry.timestampSeconds).toBe(next.timestampSeconds);
  });

  it("shortens claim deadlines to terminal or lease expiry and checks elapsed time after authority", async () => {
    const f = await fixture();
    const saved = f.saved();
    f.observe(saved.registrationId, { status: "done" });
    now += 295_000;
    const terminalClaim = value(f.store.claim(saved.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(terminalClaim.attemptDeadlineMs).toBe(EPOCH + 300_000);
    const live = f.saved({ activityId: "lease-bound" });
    now = live.leaseExpiresAtMs - 2_000;
    f.observe(live.registrationId);
    const leaseClaim = value(f.store.claim(live.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(leaseClaim.attemptDeadlineMs).toBe(live.leaseExpiresAtMs);
    const active = f.saved({ activityId: "callback-bound" });
    f.observe(active.registrationId);
    const callbackClaim = value(f.store.claim(active.registrationId, isReady, ATTEMPT_TIMEOUT_MS));
    expect(
      f.store.authorizeDispatch(callbackClaim, () => {
        now = callbackClaim.attemptDeadlineMs;
        return "ready";
      }),
    ).toEqual({ ok: false, error: "stale-claim" });
    expect(f.row(active.registrationId).claim_authorized_at_ms).toBeNull();
  });

  it("requires current owner authority for revoke without mutating another owner's row", async () => {
    expectTypeOf<() => Promise<boolean>>().not.toExtend<
      Parameters<LiveActivityStore["revoke"]>[1]
    >();
    const f = await fixture();
    const saved = f.saved();
    const input = { registrationId: saved.registrationId, expectedRevision: 1 };
    const before = f.row(saved.registrationId);
    const denied: LiveActivityOwnerIsCurrent = (binding) => binding.profileId === "other-profile";
    expect(f.store.revoke(input, denied)).toEqual({ ok: false, error: "owner-changed" });
    expect(f.row(saved.registrationId)).toEqual(before);
    expect(
      f.store.revoke(input, () => {
        throw new Error("authority unavailable");
      }),
    ).toEqual({ ok: false, error: "owner-changed" });
    expect(
      Reflect.apply(f.store.revoke.bind(f.store), undefined, [input, async () => true]),
    ).toEqual({
      ok: false,
      error: "owner-changed",
    });
    expect(f.row(saved.registrationId)).toEqual(before);
    value(f.store.revoke(input, isCurrent));
    const tombstone = f.row(saved.registrationId);
    expect(f.store.revoke(input, denied)).toEqual({ ok: false, error: "owner-changed" });
    expect(f.store.revoke(input, isCurrent)).toEqual({ ok: true, value: false });
    expect(f.row(saved.registrationId)).toEqual(tombstone);
    const expiring = f.saved({ activityId: "expired-but-not-swept" });
    const expiredRow = f.row(expiring.registrationId);
    now = expiring.leaseExpiresAtMs;
    expect(
      f.store.revoke({ registrationId: expiring.registrationId, expectedRevision: 1 }, denied),
    ).toEqual({ ok: false, error: "owner-changed" });
    expect(f.row(expiring.registrationId)).toEqual(expiredRow);
  });
});
