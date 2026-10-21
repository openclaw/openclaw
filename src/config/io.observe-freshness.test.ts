import fs from "node:fs";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  executeSqliteQueryTakeFirstSync,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  captureConfigHealthStateStore,
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import { readConfigHealthStateInDatabase } from "./io.health-state.kernel.js";
import type { ConfigHealthState } from "./io.health-state.types.js";
import { createConfigIO } from "./io.js";
import * as observationState from "./io.observe-state.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { hashConfigRaw, normalizeConfigIoDeps } from "./io.read-helpers.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture(prefix: string, stateSubdir = "") {
  const home = directories.make(prefix);
  const configPath = path.join(home, "openclaw.json");
  const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, stateSubdir) };
  return { home, configPath, env, homedir: () => home, logger: { warn: vi.fn(), error: vi.fn() } };
}

function readHealthRow(db: ReturnType<typeof openOpenClawStateDatabase>["db"], configPath: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("config_health_entries")
      .selectAll()
      .where("config_path", "=", configPath),
  );
}

it.each([
  { phase: "after basis read", present: true, suspicious: false },
  { phase: "before admission", present: true, suspicious: false },
  { phase: "after dispatch", present: true, suspicious: false },
  { phase: "after dispatch", present: false, suspicious: false },
  { phase: "after dispatch", present: true, suspicious: true },
  { phase: "audit dispatched", present: true, suspicious: true },
])(
  "preserves newer persisted health facts $phase (existing row: $present, suspicious: $suspicious)",
  async ({ phase, present, suspicious }) => {
    const context = fixture("openclaw-observation-freshness-", "state-root");
    const { home, configPath } = context;
    const siblingPath = path.join(home, "sibling.json");
    const env = {
      ...context.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    };
    const options = {
      ...context,
      env,
    };
    const raw = (port: number) =>
      JSON.stringify({
        meta: { lastTouchedVersion: "2026.9.4" },
        gateway: { mode: "local", port },
      });
    const baselineRaw = raw(18789);
    const olderRaw = suspicious ? JSON.stringify({ update: { channel: "beta" } }) : baselineRaw;
    const newerRaw = suspicious ? JSON.stringify({ update: { channel: "stable" } }) : raw(18799);
    const readSnapshot = async (bytes: string) => {
      fs.writeFileSync(configPath, bytes);
      const snapshot = await createConfigIO({
        ...options,
        observe: false,
      }).readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      return snapshot;
    };
    const newer = await readSnapshot(newerRaw);
    await readSnapshot(olderRaw);
    const oldPromotion = observationState.createConfigHealthFingerprint({
      raw: baselineRaw,
      parsed: JSON.parse(baselineRaw),
      stat: fs.statSync(configPath),
      observedAt: "2000-01-01T00:00:00.000Z",
    });
    const timestamp = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(timestamp);
    if (present) {
      patchConfigHealthEntryToStore(options, configPath, {
        lastPromotedGood: oldPromotion,
        ...(suspicious
          ? { lastKnownGood: oldPromotion, lastObservedSuspiciousSignature: "seed" }
          : {}),
      });
    }
    patchConfigHealthEntryToStore(options, siblingPath, {
      lastKnownGood: oldPromotion,
      lastPromotedGood: oldPromotion,
    });
    const baseline = readConfigHealthStateFromStore(options);
    const { db } = openOpenClawStateDatabase({ env });
    const readUpdatedAt = () => readHealthRow(db, configPath)?.updated_at_ms;
    if (present) {
      expect(readUpdatedAt()).toBe(timestamp);
    }

    const entered = createDeferredCore();
    const release = createDeferredCore();
    const deps = normalizeConfigIoDeps(options);
    const observationWork = new AsyncWorkScope();
    let expected: ConfigHealthState | undefined;
    let intervened = false;
    const writeNewerObservation = () =>
      observationWork.run(() => {
        fs.writeFileSync(configPath, newerRaw);
        observeConfigSnapshotSync(deps, newer);
        expected = readConfigHealthStateInDatabase(db);
        if (suspicious) {
          expect(expected.entries?.[configPath]?.lastObservedSuspiciousSignature).toContain(
            hashConfigRaw(newerRaw),
          );
        } else {
          expect(expected.entries?.[configPath]?.lastKnownGood?.hash).toBe(hashConfigRaw(newerRaw));
        }
        expect(readUpdatedAt()).toBe(timestamp);
        intervened = true;
      });
    if (phase === "before admission") {
      const readFingerprint = observationState.readConfigFingerprintForPath;
      vi.spyOn(observationState, "readConfigFingerprintForPath").mockImplementation(
        async (...args) => {
          const result = await readFingerprint(...args);
          if (args[1] === `${configPath}.bak`) {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      );
    } else if (phase === "after basis read") {
      const read = stateReads.executeExistingOpenClawStateRead;
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockImplementation(
        async (...args) => {
          const reply = await read(...args);
          if (!intervened && args[1].type === "config.health.read") {
            writeNewerObservation();
          }
          return reply;
        },
      );
    } else {
      const postMessage = vi.spyOn(Worker.prototype, "postMessage");
      Worker.prototype.postMessage = function (this: Worker, ...args) {
        const request: unknown = args[0];
        const command: unknown =
          isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array
            ? deserialize(request.input)
            : undefined;
        if (
          !intervened &&
          isRecord(command) &&
          isRecord(command.input) &&
          (phase === "audit dispatched"
            ? command.type === "diagnostic.register" && command.input.scope === "config-audit"
            : command.type === "config.health.patch" && command.input.configPath === configPath)
        ) {
          // Hold the ordinary SQLite writer before dispatch. The synchronous observer
          // commits after postMessage, before the worker can admit its write transaction.
          runOpenClawStateWriteTransaction(
            () => {
              Reflect.apply(postMessage, this, args);
              writeNewerObservation();
            },
            { env },
          );
          return;
        }
        Reflect.apply(postMessage, this, args);
      };
    }
    const pending = createConfigIO(options).readConfigFileSnapshot();
    try {
      if (phase === "before admission") {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Observation completed before the controlled delay");
          }),
        ]);
        writeNewerObservation();
        release.resolve();
      }
      expect((await pending).valid).toBe(true);
      await observationWork.drain();
      expect(intervened).toBe(true);
      expect(expected).toBeDefined();
      expect(readConfigHealthStateFromStore(options)).toEqual(expected);
      expect(expected?.entries?.[siblingPath]).toEqual(baseline.entries?.[siblingPath]);
      await closeOpenClawStateDatabaseAsync();
      expect(readConfigHealthStateFromStore(options)).toEqual(expected);
    } finally {
      release.resolve();
      try {
        await pending;
      } finally {
        await observationWork.drain();
      }
    }
  },
);

it.each([' { "hash" : "legacy" } ', "{invalid"])(
  "compares raw legacy health facts without tightening their decoder: %s",
  async (legacyText) => {
    const deps = fixture("openclaw-health-legacy-basis-");
    const { configPath, env } = deps;
    patchConfigHealthEntryToStore(deps, configPath, {
      lastObservedSuspiciousSignature: "seed",
    });
    const { db } = openOpenClawStateDatabase({ env });
    const readRow = () => readHealthRow(db, configPath);
    const writeRaw = (text: string) =>
      runOpenClawStateWriteTransaction(
        ({ db: writeDb }) => {
          executeSqliteQuerySync(
            writeDb,
            getNodeSqliteKysely<DB>(writeDb)
              .updateTable("config_health_entries")
              .set({ last_known_good_json: text })
              .where("config_path", "=", configPath),
          );
        },
        { env },
      );
    writeRaw(legacyText);
    const store = captureConfigHealthStateStore(deps, configPath);
    const initialRead = await store.read();
    await store.update({ lastObservedSuspiciousSignature: "applied" }, initialRead);
    expect(readRow()?.last_known_good_json).toBe(legacyText);
    const snapshot = await store.read();
    const currentTimestamp = readRow()?.updated_at_ms;
    writeRaw(`${legacyText} `);
    expect(readRow()?.updated_at_ms).toBe(currentTimestamp);
    await store.update({ lastObservedSuspiciousSignature: "stale" }, snapshot);
    expect(readRow()).toMatchObject({
      last_known_good_json: `${legacyText} `,
      last_observed_suspicious_signature: "applied",
      updated_at_ms: currentTimestamp,
    });
    expect((await store.read())?.state).toEqual(snapshot.state);
  },
);
