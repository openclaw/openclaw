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
import { createDeferredCore } from "../shared/deferred.js";
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
import * as healthOwner from "./io.health-state.js";
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

it.each([
  { phase: "before basis", present: true, suspicious: false, producer: "sync" },
  { phase: "before basis", present: true, suspicious: false, producer: "async" },
  { phase: "basis dispatched", present: true, suspicious: false, producer: "sync" },
  { phase: "before basis", present: false, suspicious: false, producer: "sync" },
  { phase: "before basis", present: true, suspicious: true, producer: "sync" },
  { phase: "before admission", present: true, suspicious: false, producer: "sync" },
  { phase: "before admission", present: false, suspicious: false, producer: "sync" },
  { phase: "after dispatch", present: true, suspicious: false, producer: "sync" },
  { phase: "after dispatch", present: false, suspicious: false, producer: "sync" },
  { phase: "after dispatch", present: true, suspicious: true, producer: "sync" },
])(
  "preserves a newer $producer observation $phase (existing row: $present, suspicious: $suspicious)",
  async ({ phase, present, suspicious, producer }) => {
    const home = directories.make("openclaw-observation-freshness-");
    const configPath = path.join(home, "openclaw.json");
    const siblingPath = path.join(home, "sibling.json");
    const env = {
      HOME: home,
      OPENCLAW_STATE_DIR: path.join(home, "state-root"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      VITEST: "true",
    };
    const options = {
      env,
      homedir: () => home,
      configPath,
      logger: { warn: vi.fn(), error: vi.fn() },
    };
    const raw = (port: number) =>
      JSON.stringify({
        meta: { lastTouchedVersion: "2026.9.4" },
        gateway: { mode: "local", port },
      });
    const baselineRaw = raw(18789);
    const olderRaw = suspicious ? JSON.stringify({ update: { channel: "beta" } }) : baselineRaw;
    const newerRaw = suspicious ? JSON.stringify({ update: { channel: "stable" } }) : raw(18799);
    fs.writeFileSync(configPath, newerRaw);
    const newer = await createConfigIO({ ...options, observe: false }).readConfigFileSnapshot();
    expect(newer.valid).toBe(true);
    fs.writeFileSync(configPath, olderRaw);
    const older = await createConfigIO({ ...options, observe: false }).readConfigFileSnapshot();
    expect(older.valid).toBe(true);
    const oldPromotion = observationState.createConfigHealthFingerprint({
      raw: baselineRaw,
      parsed: JSON.parse(baselineRaw),
      stat: fs.statSync(configPath),
      observedAt: "2000-01-01T00:00:00.000Z",
    });
    const timestamp = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(timestamp);
    const initial = {
      entries: {
        ...(present
          ? {
              [configPath]: {
                lastPromotedGood: oldPromotion,
                ...(suspicious
                  ? { lastKnownGood: oldPromotion, lastObservedSuspiciousSignature: "seed" }
                  : {}),
              },
            }
          : {}),
        [siblingPath]: { lastKnownGood: oldPromotion, lastPromotedGood: oldPromotion },
      },
    };
    for (const [entryPath, entry] of Object.entries(initial.entries)) {
      patchConfigHealthEntryToStore(options, entryPath, entry);
    }
    const baseline = readConfigHealthStateFromStore(options);
    const { db } = openOpenClawStateDatabase({ env });
    const readUpdatedAt = () =>
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("config_health_entries")
          .select("updated_at_ms")
          .where("config_path", "=", configPath),
      );
    if (present) {
      expect(readUpdatedAt()?.updated_at_ms).toBe(timestamp);
    }

    const entered = createDeferredCore();
    const release = createDeferredCore();
    const deps = normalizeConfigIoDeps(options);
    let expected: ConfigHealthState | undefined;
    let expectedWarnings = 0;
    let intervened = false;
    const recordNewerObservation = () => {
      expected = readConfigHealthStateInDatabase(db);
      if (suspicious) {
        expect(expected.entries?.[configPath]?.lastObservedSuspiciousSignature).toContain(
          hashConfigRaw(newerRaw),
        );
      } else {
        expect(expected.entries?.[configPath]?.lastKnownGood?.hash).toBe(hashConfigRaw(newerRaw));
      }
      expect(readUpdatedAt()?.updated_at_ms).toBe(timestamp);
      expectedWarnings = options.logger.warn.mock.calls.length;
      intervened = true;
    };
    const writeNewerObservation = () => {
      fs.writeFileSync(configPath, newerRaw);
      observeConfigSnapshotSync(deps, newer);
      recordNewerObservation();
    };
    const writeNewerAsyncObservation = async () => {
      intervened = true;
      fs.writeFileSync(configPath, newerRaw);
      expect((await createConfigIO(options).readConfigFileSnapshot()).valid).toBe(true);
      recordNewerObservation();
    };
    if (phase === "before basis") {
      const capture = healthOwner.captureConfigHealthStateStore;
      vi.spyOn(healthOwner, "captureConfigHealthStateStore").mockImplementation((...args) => {
        const store = capture(...args);
        return {
          ...store,
          async read() {
            if (!intervened && args[1] === configPath) {
              if (producer === "async") {
                await writeNewerAsyncObservation();
              } else {
                writeNewerObservation();
              }
            }
            return store.read();
          },
        };
      });
    } else if (phase === "before admission") {
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
          (phase === "basis dispatched"
            ? command.type === "config.health.read"
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
      expect(intervened).toBe(true);
      expect(expected).toBeDefined();
      expect(options.logger.warn.mock.calls).toHaveLength(expectedWarnings);
      expect(readConfigHealthStateFromStore(options)).toEqual(expected);
      expect(expected?.entries?.[siblingPath]).toEqual(baseline.entries?.[siblingPath]);
      await closeOpenClawStateDatabaseAsync();
      expect(readConfigHealthStateFromStore(options)).toEqual(expected);
    } finally {
      release.resolve();
      await pending;
    }
  },
);

it.each([' { "hash" : "legacy" } ', '["legacy"]', "{invalid"])(
  "compares raw legacy health facts without tightening their decoder: %s",
  async (legacyText) => {
    const home = directories.make("openclaw-health-legacy-basis-");
    const configPath = path.join(home, "openclaw.json");
    const env = { HOME: home, OPENCLAW_STATE_DIR: home };
    const deps = { env, homedir: () => home, logger: { warn: vi.fn() } };
    patchConfigHealthEntryToStore(deps, configPath, {
      lastObservedSuspiciousSignature: "seed",
    });
    const { db } = openOpenClawStateDatabase({ env });
    const readRow = () =>
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("config_health_entries")
          .selectAll()
          .where("config_path", "=", configPath),
      );
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
    using store = captureConfigHealthStateStore(deps, configPath);
    const initialRead = await store.read();
    if (!initialRead) {
      throw new Error("Fixture health read was superseded");
    }
    await store.update({ lastObservedSuspiciousSignature: "applied" }, initialRead);
    expect(readRow()?.last_known_good_json).toBe(legacyText);
    const snapshot = await store.read();
    if (!snapshot) {
      throw new Error("Fixture health read was superseded");
    }
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
