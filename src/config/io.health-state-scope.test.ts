import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as sharedWorker from "../state/openclaw-state-worker-store.js";
import {
  captureConfigHealthStateStore,
  readConfigHealthStateFromStore,
  patchConfigHealthEntryToStore,
} from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import { createConfigIO } from "./io.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture() {
  const home = directories.make("openclaw-health-scope-");
  const deps = {
    env: { HOME: home, OPENCLAW_STATE_DIR: home },
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  const configPath = path.join(home, "openclaw.json");
  patchConfigHealthEntryToStore(deps, configPath, {
    lastObservedSuspiciousSignature: "before",
  });
  return { deps, configPath };
}

it("reads recovery health from the admitted snapshot without overwriting a foreign commit", async () => {
  const { deps, configPath } = fixture();
  await closeOpenClawStateDatabaseAsync();
  using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(deps.env));
  const observation = captureConfigHealthStateStore(deps, configPath);
  const before = await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      writer
        .prepare(
          "UPDATE config_health_entries SET last_observed_suspicious_signature = ? WHERE config_path = ?",
        )
        .run("foreign commit", configPath);
      return observation.read();
    },
    { env: deps.env },
  );
  expect(before?.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("before");
  await observation.update({ lastObservedSuspiciousSignature: "stale recovery" }, before);
  expect(
    readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
  ).toBe("foreign commit");
});

it("reads committed worker health writes and rejects a stale patch basis", async () => {
  const { deps, configPath } = fixture();
  const observation = captureConfigHealthStateStore(deps, configPath);
  const before = await observation.read();
  if (!before) {
    throw new Error("Expected a current health observation");
  }
  await observation.update({ lastObservedSuspiciousSignature: "after" }, before);

  const current = captureConfigHealthStateStore(deps, configPath);
  expect((await current.read())?.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
    "after",
  );
  await current.update({ lastObservedSuspiciousSignature: "stale" }, before);
  expect((await current.read())?.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
    "after",
  );
});

it("compares every raw health field and absence before applying an observed patch", async () => {
  const { deps, configPath } = fixture();
  await closeOpenClawStateDatabaseAsync();
  using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(deps.env));
  const row = () =>
    writer.prepare("SELECT * FROM config_health_entries WHERE config_path = ?").get(configPath);
  for (const [column, value] of [
    ["last_known_good_json", '{ "hash": "foreign" }'],
    ["last_promoted_good_json", '{"hash":"promoted"}'],
    ["last_observed_suspicious_signature", null],
    ["updated_at_ms", 123],
  ] as const) {
    const observation = captureConfigHealthStateStore(deps, configPath);
    const before = await observation.read();
    writer
      .prepare(`UPDATE config_health_entries SET ${column} = ? WHERE config_path = ?`)
      .run(value, configPath);
    const foreign = row();
    await observation.update({ lastObservedSuspiciousSignature: "stale" }, before);
    expect(row()).toEqual(foreign);
  }

  writer.prepare("DELETE FROM config_health_entries WHERE config_path = ?").run(configPath);
  const observation = captureConfigHealthStateStore(deps, configPath);
  const absent = await observation.read();
  writer
    .prepare(
      "INSERT INTO config_health_entries(config_path, last_observed_suspicious_signature, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run(configPath, "concurrently created", 456);
  const foreign = row();
  await observation.update({ lastObservedSuspiciousSignature: "stale creation" }, absent);
  expect(row()).toEqual(foreign);
});

it.each([false, true])(
  "preserves nested health facts and original-row comparison across outer rollback: %s",
  async (rollback) => {
    const { deps, configPath } = fixture();
    const observation = captureConfigHealthStateStore(deps, configPath);
    const before = await observation.read();
    expect(before.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("before");
    const abort = new Error("fixture outer rollback");
    const mutate = () =>
      runOpenClawStateWriteTransaction(
        () => {
          patchConfigHealthEntryToStore(deps, configPath, {
            lastObservedSuspiciousSignature: "after",
          });
          expect(() => observation.assertCurrent()).not.toThrow();
          if (rollback) {
            throw abort;
          }
        },
        { env: deps.env },
      );
    if (rollback) {
      expect(mutate).toThrow(abort);
    } else {
      mutate();
    }
    expect(
      readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
    ).toBe(rollback ? "before" : "after");
    if (rollback) {
      expect(await observation.read()).toEqual(before);
    } else {
      await observation.update({ lastObservedSuspiciousSignature: "stale" }, before);
      expect(
        readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
      ).toBe("after");
    }
  },
);

it("retains its captured database when the environment changes after planning", async () => {
  const { deps, configPath } = fixture();
  const planning = captureConfigHealthStateStore(deps, configPath);
  expect(await planning.read()).not.toBeNull();
  deps.env.OPENCLAW_STATE_DIR = directories.make("openclaw-other-health-store-");
  patchConfigHealthEntryToStore(deps, configPath, {
    lastObservedSuspiciousSignature: "other-store",
  });
  expect((await planning.read()).state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
    "before",
  );
});

it("keeps sibling health rows and pending async observations independent of a sync observation", async () => {
  const { deps, configPath } = fixture();
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: "local" } }));
  const snapshot = await createConfigIO({
    ...deps,
    configPath,
    observe: false,
  }).readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  const siblingPath = path.join(deps.env.HOME, "sibling.json");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  patchConfigHealthEntryToStore(deps, siblingPath, {
    lastObservedSuspiciousSignature: "sibling-before",
  });
  const sibling = captureConfigHealthStateStore(deps, siblingPath);
  const before = await sibling.read();
  expect(before?.basis?.[siblingPath]).toBeDefined();

  now.mockReturnValue(1_700_000_000_001);
  observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
  expect(() => sibling.assertCurrent()).not.toThrow();
  expect((await sibling.read())?.basis?.[siblingPath]).toEqual(before.basis?.[siblingPath]);
  await sibling.update({ lastObservedSuspiciousSignature: "sibling-after" }, before);
  await closeOpenClawStateDatabaseAsync();
  expect(
    readConfigHealthStateFromStore(deps).entries?.[siblingPath]?.lastObservedSuspiciousSignature,
  ).toBe("sibling-after");
});

it("preserves worker-updated fields omitted by an already-read synchronous observation", async () => {
  const { deps, configPath } = fixture();
  const raw = JSON.stringify({ gateway: { mode: "local" } });
  fs.writeFileSync(configPath, raw);
  const snapshot = await createConfigIO({
    ...deps,
    configPath,
    observe: false,
  }).readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  const priorState = readConfigHealthStateFromStore(deps);
  const promoted = createConfigHealthFingerprint({
    raw,
    parsed: snapshot.parsed,
    stat: fs.statSync(configPath),
  });
  const workerObservation = captureConfigHealthStateStore(deps, configPath);
  const basis = await workerObservation.read();
  await workerObservation.update({ lastPromotedGood: promoted }, basis);
  const committed = readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastPromotedGood;
  expect(committed).toEqual(promoted);

  const read = vi
    .spyOn(healthOwner, "readConfigHealthStateFromStore")
    .mockReturnValueOnce(priorState);
  observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
  read.mockRestore();
  await closeOpenClawStateDatabaseAsync();
  const after = readConfigHealthStateFromStore(deps).entries?.[configPath];
  expect(after?.lastKnownGood?.hash).toBe(promoted.hash);
  expect(after?.lastPromotedGood).toEqual(committed);
});

it.each(["read", "update"] as const)(
  "rejects retired database admission during health %s",
  async (operation) => {
    const { deps, configPath } = fixture();
    const observation = captureConfigHealthStateStore(deps, configPath);
    const before = await observation.read();
    await closeOpenClawStateDatabaseAsync();
    await expect(
      operation === "read"
        ? observation.read()
        : observation.update({ lastObservedSuspiciousSignature: "stale" }, before),
    ).rejects.toThrow("read admission");
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(
      readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
    ).toBe("before");
  },
);

it("keeps a confirmed health write successful when its database is then closed", async () => {
  const { deps, configPath } = fixture();
  const observation = captureConfigHealthStateStore(deps, configPath);
  const before = await observation.read();
  if (!before) {
    throw new Error("Expected current observation");
  }
  const execute = sharedWorker.runOpenClawStateWorkerOperation;
  let applied: unknown;
  const spy = vi.spyOn(sharedWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(execute, {
      async apply(target, receiver, args) {
        const result: unknown = await Reflect.apply(target, receiver, args);
        applied = result;
        await closeOpenClawStateDatabaseAsync();
        return result;
      },
    }),
  );
  try {
    await observation.update({ lastObservedSuspiciousSignature: "committed" }, before);
  } finally {
    spy.mockRestore();
  }
  expect(applied).toBe(true);
  expect(deps.logger.warn).not.toHaveBeenCalled();
  expect(
    readConfigHealthStateFromStore(deps).entries?.[configPath]?.lastObservedSuspiciousSignature,
  ).toBe("committed");
});
