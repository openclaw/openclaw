import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { err, ok } from "@openclaw/normalization-core/result";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "./kysely-sync.js";
import {
  TABLE,
  LEASE_MS,
  TERMINAL_RETRY_MS,
  LIVE_ACTIVITY_MAX_ATTEMPT_MS,
  MAX_ROWS,
  MAX_GATEWAY_ACTIVITIES,
  MAX_DEVICE_ACTIVITIES,
  MAX_SNAPSHOT_BYTES,
  MAX_DESTINATION_BYTES,
  ensureSchema,
  bindingSchema,
  destinationSchema,
  snapshotSchema,
  observationSchema,
  registrationSchema,
  stateDb,
  bindingColumns,
  sameBinding,
  parseSnapshot,
  parseDestination,
  registration,
  terminal,
  nowMs,
  readRow,
  readActivityRow,
  updateRow,
  clearedClaim,
  retire,
  expiry,
  sweepRows,
  ownerCurrent,
  deliveryOwnerCurrent,
  matchesClaim,
  nextProgress,
  type ActivityRow,
  type StoreResult,
  type LiveActivityBinding,
  type LiveActivityDestination,
  type LiveActivityObservation,
  type LiveActivityRegistrationInput,
  type LiveActivityRegistration,
  type LiveActivityOwnerIsCurrent,
  type LiveActivityDeliveryState,
  type LiveActivityDeliveryOwner,
  type LiveActivityClaim,
} from "./push-live-activity-store-state.js";

export { LIVE_ACTIVITY_MAX_ATTEMPT_MS } from "./push-live-activity-store-state.js";
export type {
  LiveActivityBinding,
  LiveActivityDestination,
  LiveActivitySnapshot,
  LiveActivityObservation,
  LiveActivityRegistrationInput,
  LiveActivityRegistration,
  LiveActivityOwnerIsCurrent,
  LiveActivityDeliveryState,
  LiveActivityDeliveryOwner,
  LiveActivityClaim,
} from "./push-live-activity-store-state.js";

/**
 * One Gateway lifecycle owns one store instance. Persisted claim IDs are fences,
 * never restart authority; only this instance's exact claim objects can dispatch.
 */
export class LiveActivityStore {
  private readonly runtimeId = randomUUID();
  private readonly claims = new WeakMap<
    LiveActivityClaim,
    {
      db: DatabaseSync;
      authorized: boolean;
    }
  >();
  private closed = false;

  constructor(private readonly options: OpenClawStateDatabaseOptions = {}) {}

  close(): void {
    this.closed = true;
  }

  private read<T>(operation: (db: DatabaseSync) => T): T | undefined {
    if (this.options.database) {
      return operation(this.options.database.db);
    }
    return withExistingOpenClawStateDatabaseReadOnly(({ db }) => operation(db), this.options);
  }

  load(registrationId: string): LiveActivityRegistration | null {
    return (
      this.read((db) => {
        const row = tableExists(db, TABLE) ? readRow(db, registrationId) : undefined;
        return row ? registration(row) : null;
      }) ?? null
    );
  }

  loadByActivity(
    gatewayId: string,
    deviceId: string,
    activityId: string,
  ): LiveActivityRegistration | null {
    const row = this.read((db) => readActivityRow(db, { gatewayId, deviceId }, activityId));
    const retained = row?.state !== "tombstone" || (row.tombstone_expires_at_ms ?? 0) > nowMs();
    return row && retained ? registration(row) : null;
  }

  list(gatewayId: string): LiveActivityRegistration[] {
    return (
      this.read((db) =>
        tableExists(db, TABLE)
          ? executeSqliteQuerySync(
              db,
              stateDb(db)
                .selectFrom(TABLE)
                .selectAll()
                .where("gateway_id", "=", gatewayId)
                .where("state", "!=", "tombstone")
                .orderBy("created_at_ms")
                .orderBy("registration_id"),
            ).rows.map(registration)
          : [],
      ) ?? []
    );
  }

  /** Retained tombstones still need a cleanup wake after the last activity ends. */
  nextMaintenanceAtMs(): number | null {
    return (
      this.read((db) => {
        if (!tableExists(db, TABLE)) {
          return null;
        }
        const deadlines = executeSqliteQueryTakeFirstSync(
          db,
          stateDb(db)
            .selectFrom(TABLE)
            .select((eb) => [
              eb.fn
                .min<number | null>("lease_expires_at_ms")
                .filterWhere("state", "!=", "tombstone")
                .as("lease"),
              eb.fn
                .min<number | null>("terminal_deadline_ms")
                .filterWhere("state", "=", "terminal_pending")
                .as("terminal"),
              eb.fn
                .min<number | null>("tombstone_expires_at_ms")
                .filterWhere("state", "=", "tombstone")
                .as("tombstone"),
            ]),
        );
        const nextAt = Math.min(
          deadlines?.lease ?? Infinity,
          deadlines?.terminal ?? Infinity,
          deadlines?.tombstone ?? Infinity,
        );
        return nextAt === Infinity ? null : nextAt;
      }) ?? null
    );
  }

  private withRow<T>(
    id: string,
    operation: (db: DatabaseSync, row: ActivityRow, now: number) => StoreResult<T>,
  ): StoreResult<T> {
    if (this.closed) {
      return err("closed");
    }
    if (!this.read((db) => tableExists(db, TABLE))) {
      return err("not-found");
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const row = readRow(db, id);
        if (!row) {
          return err("not-found");
        }
        const now = nowMs();
        if (now < row.updated_at_ms) {
          return err("clock-regressed");
        }
        return operation(db, row, now);
      },
      this.options,
      { operationLabel: "apns.live-activity.write" },
    );
  }

  private mutate<T>(
    id: string,
    operation: (db: DatabaseSync, row: ActivityRow, now: number) => StoreResult<T>,
  ): StoreResult<T> {
    return this.withRow(id, (db, row, now) => {
      if (row.state !== "tombstone") {
        const reason = expiry(row, now);
        if (reason) {
          retire(
            db,
            row,
            reason,
            Math.min(row.lease_expires_at_ms, row.terminal_deadline_ms ?? Infinity),
            now,
          );
          return err("retired");
        }
      }
      return operation(db, row, now);
    });
  }

  private checkOwner(
    db: DatabaseSync,
    row: ActivityRow,
    now: number,
    current: boolean | LiveActivityDeliveryState,
    retireChangedOwner = true,
  ): StoreResult<number> {
    if (this.closed) {
      return err("closed");
    }
    // A synchronous callback may re-enter a lifecycle owner. Never let its stale
    // row retire a rotated token or restore a claim invalidated during that call.
    const after = readRow(db, row.registration_id);
    if (
      !after ||
      after.rotation_revision !== row.rotation_revision ||
      after.delivery_revision !== row.delivery_revision ||
      after.dispatch_revision !== row.dispatch_revision ||
      after.state !== row.state ||
      after.claim_id !== row.claim_id ||
      after.claim_authorized_at_ms !== row.claim_authorized_at_ms ||
      after.claim_deadline_ms !== row.claim_deadline_ms ||
      after.next_attempt_at_ms !== row.next_attempt_at_ms
    ) {
      return err("revision-conflict");
    }
    const checkedAt = nowMs();
    if (checkedAt < now) {
      return err("clock-regressed");
    }
    if (current === false || current === "lost") {
      if (retireChangedOwner) {
        retire(db, row, "owner-retired", checkedAt, checkedAt);
      }
      return err("owner-changed");
    }
    const reason = row.state === "tombstone" ? undefined : expiry(row, checkedAt);
    if (reason) {
      retire(
        db,
        row,
        reason,
        Math.min(row.lease_expires_at_ms, row.terminal_deadline_ms ?? Infinity),
        checkedAt,
      );
      return err("retired");
    }
    return current === "held" ? err("not-due") : ok(checkedAt);
  }

  register(
    input: LiveActivityRegistrationInput,
    isCurrent: LiveActivityOwnerIsCurrent,
  ): StoreResult<LiveActivityRegistration> {
    if (this.closed) {
      return err("closed");
    }
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) {
      return err("invalid-input");
    }
    const candidate = parsed.data;
    const destination = JSON.stringify(candidate.destination);
    if (Buffer.byteLength(destination) > MAX_DESTINATION_BYTES) {
      return err("invalid-input");
    }
    return runOpenClawStateWriteTransaction(
      (database) => {
        const { db } = database;
        const now = nowMs();
        const row: ActivityRow = {
          ...bindingColumns(candidate.binding),
          registration_id: randomUUID(),
          activity_id: candidate.activityId,
          source_incarnation: candidate.sourceIncarnation,
          destination_json: destination,
          state: "active",
          rotation_revision: 1,
          delivery_revision: 0,
          dispatch_revision: 0,
          delivery_timestamp_s: null,
          last_dispatch_timestamp_s: null,
          snapshot_json: null,
          created_at_ms: now,
          updated_at_ms: now,
          lease_expires_at_ms: now + LEASE_MS,
          terminal_deadline_ms: null,
          next_attempt_at_ms: null,
          last_attempt_at_ms: null,
          retired_at_ms: null,
          tombstone_expires_at_ms: null,
          retirement_reason: null,
          ...clearedClaim,
        };
        if (!ownerCurrent(db, row, isCurrent) || this.closed) {
          return err("owner-changed");
        }
        ensureSchema({ ...this.options, database });
        const swept = sweepRows(db, now);
        if (!swept.ok) {
          return swept;
        }
        const existing = readActivityRow(db, candidate.binding, candidate.activityId);
        if (existing) {
          if (now < existing.updated_at_ms) {
            return err("clock-regressed");
          }
          if (
            !sameBinding(existing, candidate.binding) ||
            existing.source_incarnation !== candidate.sourceIncarnation
          ) {
            return err("binding-conflict");
          }
          if (existing.state === "tombstone") {
            return err("retired");
          }
          return existing.destination_json === destination
            ? ok(registration(existing))
            : err("revision-conflict");
        }
        const counts = executeSqliteQuerySync(
          db,
          stateDb(db).selectFrom(TABLE).select(["gateway_id", "device_id", "state"]),
        ).rows;
        const sendable = counts.filter(
          (entry) => entry.gateway_id === row.gateway_id && entry.state !== "tombstone",
        );
        if (
          counts.length >= MAX_ROWS ||
          sendable.length >= MAX_GATEWAY_ACTIVITIES ||
          counts.filter((entry) => entry.device_id === row.device_id && entry.state !== "tombstone")
            .length >= MAX_DEVICE_ACTIVITIES
        ) {
          return err("capacity");
        }
        executeSqliteQuerySync(db, stateDb(db).insertInto(TABLE).values(row));
        return ok(registration(row));
      },
      this.options,
      { operationLabel: "apns.live-activity.register" },
    );
  }

  rotate(
    input: {
      registrationId: string;
      expectedRevision: number;
      destination: LiveActivityDestination;
    },
    isCurrent: LiveActivityOwnerIsCurrent,
  ): StoreResult<LiveActivityRegistration> {
    const parsed = destinationSchema.safeParse(input.destination);
    if (
      !parsed.success ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      return err("invalid-input");
    }
    const destination = JSON.stringify(parsed.data);
    if (Buffer.byteLength(destination) > MAX_DESTINATION_BYTES) {
      return err("invalid-input");
    }
    return this.mutate(input.registrationId, (db, row, now) => {
      if (row.state === "tombstone") {
        return err("retired");
      }
      if (row.rotation_revision !== input.expectedRevision) {
        return err("revision-conflict");
      }
      const owner = this.checkOwner(db, row, now, ownerCurrent(db, row, isCurrent));
      if (!owner.ok) {
        return owner;
      }
      const checkedAt = owner.value;
      if (row.destination_json === destination) {
        return ok(registration(row));
      }
      const previous = parseDestination(row);
      const next = parsed.data;
      if (
        previous.transport !== next.transport ||
        previous.topic !== next.topic ||
        previous.environment !== next.environment ||
        (previous.transport === "relay" &&
          next.transport === "relay" &&
          (previous.installationId !== next.installationId ||
            previous.relayOrigin !== next.relayOrigin ||
            next.relayRevision <= previous.relayRevision))
      ) {
        return err("binding-conflict");
      }
      if (row.rotation_revision === Number.MAX_SAFE_INTEGER) {
        return err("revision-exhausted");
      }
      return ok(
        registration(
          updateRow(db, row.registration_id, {
            ...clearedClaim,
            destination_json: destination,
            rotation_revision: row.rotation_revision + 1,
            next_attempt_at_ms: row.snapshot_json === null ? null : nextProgress(row, checkedAt),
            updated_at_ms: checkedAt,
          }),
        ),
      );
    });
  }

  /** Terminal input must come from the exact committed owner; isCurrent revalidates its authority. */
  observe(
    registrationId: string,
    input: LiveActivityObservation,
    isCurrent: LiveActivityOwnerIsCurrent,
  ): StoreResult<LiveActivityRegistration> {
    const parsed = observationSchema.safeParse(input);
    if (!parsed.success) {
      return err("invalid-input");
    }
    const observation = parsed.data;
    return this.mutate(registrationId, (db, row, now) => {
      if (row.state === "tombstone") {
        return err("retired");
      }
      if (observation.sourceIncarnation !== row.source_incarnation) {
        return err("source-changed");
      }
      if (observation.observedAtMs > now) {
        return err("invalid-input");
      }
      const previous = parseSnapshot(row);
      // Committed closure follows progress without inventing a source event.
      // A terminal snapshot retains the progress watermark; zero means none.
      const fact = snapshotSchema.parse({
        ...observation,
        sequence: "sequence" in observation ? observation.sequence : (previous?.sequence ?? 0),
      });
      const snapshot = JSON.stringify(fact);
      if (Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) {
        return err("snapshot-too-large");
      }
      if (
        previous &&
        !terminal(previous) &&
        (fact.observedAtMs < previous.observedAtMs ||
          ("sequence" in observation &&
            (fact.sequence < previous.sequence ||
              (fact.sequence === previous.sequence && snapshot !== row.snapshot_json))))
      ) {
        return err("out-of-order");
      }
      const owner = this.checkOwner(db, row, now, ownerCurrent(db, row, isCurrent));
      if (!owner.ok) {
        return owner;
      }
      const checkedAt = owner.value;
      if (previous && (terminal(previous) || snapshot === row.snapshot_json)) {
        return ok(registration(row));
      }
      if (row.delivery_revision === Number.MAX_SAFE_INTEGER) {
        return err("revision-exhausted");
      }
      const isTerminal = terminal(fact);
      // Canonical facts retain fractional milliseconds. Only the SQL deadline
      // is rounded down so retry authority never outlives the factual bound.
      const deadline = isTerminal
        ? Math.min(Math.floor(fact.observedAtMs + TERMINAL_RETRY_MS), row.lease_expires_at_ms)
        : null;
      const updated = updateRow(db, row.registration_id, {
        ...clearedClaim,
        state: isTerminal ? "terminal_pending" : "active",
        snapshot_json: snapshot,
        delivery_revision: row.delivery_revision + 1,
        delivery_timestamp_s: null,
        terminal_deadline_ms: deadline,
        next_attempt_at_ms: isTerminal ? checkedAt : nextProgress(row, checkedAt),
        updated_at_ms: checkedAt,
      });
      return ok(
        registration(
          deadline !== null && deadline <= checkedAt
            ? retire(db, updated, "terminal-expired", deadline, checkedAt)
            : updated,
        ),
      );
    });
  }

  revoke(
    input: { registrationId: string; expectedRevision: number },
    isCurrent: LiveActivityOwnerIsCurrent,
  ): StoreResult<boolean> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return err("invalid-input");
    }
    // A caller-triggered revoke must authorize before any lifecycle write.
    // Unlike background delivery, a failed caller check cannot retire this row.
    return this.withRow(input.registrationId, (db, row, now) => {
      if (row.rotation_revision !== input.expectedRevision) {
        return err("revision-conflict");
      }
      const owner = this.checkOwner(db, row, now, ownerCurrent(db, row, isCurrent), false);
      if (!owner.ok) {
        return owner;
      }
      const checkedAt = owner.value;
      if (row.state === "tombstone") {
        return ok(false);
      }
      retire(db, row, "revoked", checkedAt, checkedAt);
      return ok(true);
    });
  }

  retireOwner(binding: LiveActivityBinding): StoreResult<number> {
    const parsed = bindingSchema.safeParse(binding);
    if (!parsed.success) {
      return err("invalid-input");
    }
    if (this.closed) {
      return err("closed");
    }
    if (!this.read((db) => tableExists(db, TABLE))) {
      return ok(0);
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const now = nowMs();
        const rows = executeSqliteQuerySync(
          db,
          stateDb(db)
            .selectFrom(TABLE)
            .selectAll()
            .where("gateway_id", "=", parsed.data.gatewayId)
            .where("device_id", "=", parsed.data.deviceId)
            .where("state", "!=", "tombstone"),
        ).rows.filter((row) => sameBinding(row, parsed.data));
        if (rows.some((row) => now < row.updated_at_ms)) {
          return err("clock-regressed");
        }
        for (const row of rows) {
          retire(db, row, "owner-retired", now, now);
        }
        return ok(rows.length);
      },
      this.options,
      { operationLabel: "apns.live-activity.retire-owner" },
    );
  }

  claim(
    registrationId: string,
    isCurrent: LiveActivityDeliveryOwner,
    attemptTimeoutMs: number,
  ): StoreResult<LiveActivityClaim> {
    if (
      !Number.isSafeInteger(attemptTimeoutMs) ||
      attemptTimeoutMs < 1 ||
      attemptTimeoutMs > LIVE_ACTIVITY_MAX_ATTEMPT_MS
    ) {
      return err("invalid-input");
    }
    return this.mutate(registrationId, (db, row, now) => {
      if (row.state === "tombstone") {
        return err("retired");
      }
      const owner = this.checkOwner(db, row, now, deliveryOwnerCurrent(db, row, isCurrent));
      if (!owner.ok) {
        return owner;
      }
      const checkedAt = owner.value;
      const snapshot = parseSnapshot(row);
      if (
        !snapshot ||
        row.next_attempt_at_ms === null ||
        row.next_attempt_at_ms > checkedAt ||
        (row.claim_deadline_ms !== null && row.claim_deadline_ms > checkedAt)
      ) {
        return err("not-due");
      }
      if (row.dispatch_revision === Number.MAX_SAFE_INTEGER) {
        return err("revision-exhausted");
      }
      const timestampSeconds = row.delivery_timestamp_s ?? Math.floor(checkedAt / 1_000);
      // APNs orders whole seconds, not our revisions. Wait for a real later
      // second; retries retain the original payload timestamp byte-for-byte.
      if (
        row.delivery_timestamp_s === null &&
        row.last_dispatch_timestamp_s !== null &&
        timestampSeconds <= row.last_dispatch_timestamp_s
      ) {
        updateRow(db, row.registration_id, {
          next_attempt_at_ms: (row.last_dispatch_timestamp_s + 1) * 1_000,
          updated_at_ms: checkedAt,
        });
        return err("not-due");
      }
      const destination = parseDestination(row);
      const claimId = randomUUID();
      // The dispatcher supplies its bounded transport budget. Its cancellation
      // must use this deadline; progress cadence never renews in-flight authority.
      const attemptDeadlineMs = Math.min(
        checkedAt + attemptTimeoutMs,
        row.lease_expires_at_ms,
        row.terminal_deadline_ms ?? Infinity,
      );
      const claimed = updateRow(db, row.registration_id, {
        claim_id: claimId,
        claim_runtime_id: this.runtimeId,
        claim_deadline_ms: attemptDeadlineMs,
        claim_authorized_at_ms: null,
        dispatch_revision: row.dispatch_revision + 1,
        delivery_timestamp_s: timestampSeconds,
        next_attempt_at_ms: attemptDeadlineMs,
        updated_at_ms: checkedAt,
      });
      const claim: LiveActivityClaim = Object.freeze({
        registration: registration(claimed),
        destination: Object.freeze(destination),
        snapshot: Object.freeze(snapshot),
        claimId,
        dispatchRevision: claimed.dispatch_revision,
        timestampSeconds,
        attemptDeadlineMs,
      });
      this.claims.set(claim, { db, authorized: false });
      return ok(claim);
    });
  }

  /** Call synchronously at the transport boundary after every asynchronous preparation. */
  authorizeDispatch(
    claim: LiveActivityClaim,
    isCurrent: LiveActivityDeliveryOwner,
  ): StoreResult<void> {
    const local = this.claims.get(claim);
    if (!local || local.authorized || !local.db.isOpen) {
      return err("stale-claim");
    }
    return this.mutate(claim.registration.registrationId, (db, row, now) => {
      if (
        db !== local.db ||
        !matchesClaim(row, claim, this.runtimeId, now) ||
        row.claim_authorized_at_ms !== null
      ) {
        return err("stale-claim");
      }
      const owner = this.checkOwner(db, row, now, deliveryOwnerCurrent(db, row, isCurrent));
      if (!owner.ok) {
        return owner;
      }
      const checkedAt = owner.value;
      if (checkedAt >= claim.attemptDeadlineMs) {
        return err("stale-claim");
      }
      updateRow(db, row.registration_id, {
        claim_authorized_at_ms: checkedAt,
        last_attempt_at_ms: checkedAt,
        last_dispatch_timestamp_s: claim.timestampSeconds,
        next_attempt_at_ms: claim.attemptDeadlineMs,
        updated_at_ms: checkedAt,
      });
      local.authorized = true;
      return ok(undefined);
    });
  }

  settle(
    claim: LiveActivityClaim,
    result: "accepted" | "transient" | "permanent",
  ): StoreResult<void> {
    const local = this.claims.get(claim);
    if (!local?.authorized || !local.db.isOpen) {
      return err("stale-claim");
    }
    this.claims.delete(claim);
    return this.mutate(claim.registration.registrationId, (db, row, now) => {
      if (
        db !== local.db ||
        !matchesClaim(row, claim, this.runtimeId, now) ||
        row.claim_authorized_at_ms === null
      ) {
        return err("stale-claim");
      }
      if (result === "permanent" || (result === "accepted" && row.state === "terminal_pending")) {
        retire(
          db,
          row,
          result === "permanent" ? "delivery-rejected" : "terminal-delivered",
          now,
          now,
        );
      } else {
        updateRow(db, row.registration_id, {
          ...clearedClaim,
          next_attempt_at_ms: result === "accepted" ? null : nextProgress(row, now),
          updated_at_ms: now,
        });
      }
      return ok(undefined);
    });
  }

  sweep(): StoreResult<number> {
    if (this.closed) {
      return err("closed");
    }
    if (!this.read((db) => tableExists(db, TABLE))) {
      return ok(0);
    }
    return runOpenClawStateWriteTransaction(({ db }) => sweepRows(db, nowMs()), this.options, {
      operationLabel: "apns.live-activity.sweep",
    });
  }
}
