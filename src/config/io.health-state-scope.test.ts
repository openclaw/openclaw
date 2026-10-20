import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { migrateLegacyConfigHealth } from "../infra/state-migrations.runtime-state.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot as readSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
  runOpenClawStateWriteTransaction as writeTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as sharedWorker from "../state/openclaw-state-worker-store.js";
import {
  captureConfigHealthStateStore as captureHealth,
  readConfigHealthStateFromStore as readHealth,
  patchConfigHealthEntryToStore as patchHealth,
} from "./io.health-state.js";
import * as healthOwner from "./io.health-state.js";
import { createConfigIO } from "./io.js";
import { createConfigHealthFingerprint } from "./io.observe-state.js";
import { observeConfigSnapshotSync } from "./io.observe.js";
import { normalizeConfigIoDeps } from "./io.read-helpers.js";

const directories = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeDatabase();
    cleanup();
  }),
);

const signaturePatch = (signature: string) => ({ lastObservedSuspiciousSignature: signature });

function fixture() {
  const home = directories.make("openclaw-health-scope-");
  const deps = {
    env: { HOME: home, OPENCLAW_STATE_DIR: home },
    homedir: () => home,
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  const configPath = path.join(home, "openclaw.json");
  const setSignature = (value: string, target = configPath) =>
    patchHealth(deps, target, signaturePatch(value));
  setSignature("before");
  const entry = () => readHealth(deps).entries?.[configPath];
  const signature = () => entry()?.lastObservedSuspiciousSignature;
  const capture = (target = configPath) => captureHealth(deps, target);
  const observe = async (target = configPath) => {
    const observation = capture(target);
    return { observation, before: await observation.read() };
  };
  return { deps, configPath, entry, setSignature, signature, capture, observe };
}

async function snapshotFixture() {
  const fixtureState = fixture();
  const { deps, configPath } = fixtureState;
  const raw = JSON.stringify({ gateway: { mode: "local" } });
  fs.writeFileSync(configPath, raw);
  const io = createConfigIO({ ...deps, configPath, observe: false });
  const snapshot = await io.readConfigFileSnapshot();
  expect(snapshot.valid).toBe(true);
  return { ...fixtureState, raw, snapshot };
}

it("shares boot health observations until a committed owner write changes them", async () => {
  const { configPath, capture, setSignature } = fixture();
  await closeDatabase();
  const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const observe = () => withArtifactPreservingStateReads(() => capture().read());
  const before = await observe();
  expect(await observe()).toEqual(before);
  expect(reads).toHaveBeenCalledTimes(1);

  setSignature("sync commit");
  const after = await observe();
  expect(after.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("sync commit");
  expect(await observe()).toEqual(after);
  expect(reads).toHaveBeenCalledTimes(2);

  const owner = capture();
  await owner.update({ lastObservedSuspiciousSignature: "worker commit" }, after);
  expect((await observe()).state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
    "worker commit",
  );
  await owner.update({ lastObservedSuspiciousSignature: "stale" }, before);
  expect((await observe()).state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
    "worker commit",
  );
  expect(reads).toHaveBeenCalledTimes(3);
});

it("keeps a pinned snapshot separate from the published live health fact", async () => {
  const { deps, configPath, capture, setSignature } = fixture();
  const owner = capture();
  await owner.read();
  await readSnapshot(
    async () => {
      setSignature("live commit");
      expect(
        (await owner.read()).state.entries?.[configPath]?.lastObservedSuspiciousSignature,
      ).toBe("before");
    },
    { env: deps.env },
  );
  expect((await owner.read()).state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe(
    "live commit",
  );
});

it("publishes imported health rows to an already-read owner", async () => {
  const { deps, configPath, capture } = fixture();
  const owner = capture();
  expect((await owner.read()).state.entries?.[configPath]?.lastPromotedGood).toBeUndefined();
  const sourcePath = path.join(deps.env.HOME, "config-health.json");
  fs.writeFileSync(
    sourcePath,
    JSON.stringify({ entries: { [configPath]: { lastPromotedGood: { hash: "imported" } } } }),
  );
  expect(
    migrateLegacyConfigHealth({
      detected: { sourcePath, hasLegacy: true },
      stateDir: deps.env.HOME,
    }).warnings,
  ).toEqual([]);
  expect((await owner.read()).state.entries?.[configPath]?.lastPromotedGood?.hash).toBe("imported");
});

it("reads admitted recovery health without overwriting a foreign commit", async () => {
  const { deps, configPath, capture, signature } = fixture();
  await closeDatabase();
  using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(deps.env));
  const observation = capture();
  const before = await readSnapshot(
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
  await observation.update(signaturePatch("stale recovery"), before);
  expect(signature()).toBe("foreign commit");
});

it("reads committed worker health writes and rejects a stale patch basis", async () => {
  const { configPath, capture, observe } = fixture();
  const { observation, before } = await observe();
  await observation.update(signaturePatch("after"), before);
  const current = capture();
  const currentEntry = async () => (await current.read())?.state.entries?.[configPath];
  expect(await currentEntry()).toMatchObject(signaturePatch("after"));
  await current.update(signaturePatch("stale"), before);
  expect(await currentEntry()).toMatchObject(signaturePatch("after"));
});

it("compares every raw health field and absence before applying an observed patch", async () => {
  const { deps, configPath, observe } = fixture();
  await closeDatabase();
  using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(deps.env));
  const row = () =>
    writer.prepare("SELECT * FROM config_health_entries WHERE config_path = ?").get(configPath);
  for (const [column, value] of [
    ["last_known_good_json", '{ "hash": "foreign" }'],
    ["last_promoted_good_json", '{"hash":"promoted"}'],
    ["last_observed_suspicious_signature", null],
    ["updated_at_ms", 123],
    ["absent", null],
  ] as const) {
    if (column === "absent") {
      writer.prepare("DELETE FROM config_health_entries WHERE config_path = ?").run(configPath);
    }
    const { observation, before } = await observe();
    if (column === "absent") {
      writer
        .prepare(
          "INSERT INTO config_health_entries(config_path, last_observed_suspicious_signature, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run(configPath, "concurrently created", 456);
    } else {
      writer
        .prepare(`UPDATE config_health_entries SET ${column} = ? WHERE config_path = ?`)
        .run(value, configPath);
    }
    const foreign = row();
    await observation.update(signaturePatch("stale"), before);
    expect(row()).toEqual(foreign);
  }
});

it.each([false, true])(
  "preserves nested health facts and original-row comparison (rollback=%s)",
  async (rollback) => {
    const { deps, configPath, observe, setSignature, signature } = fixture();
    const { observation, before } = await observe();
    expect(before.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("before");
    const abort = new Error("fixture outer rollback");
    const mutate = () =>
      writeTransaction(
        () => {
          setSignature("after");
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
    expect(signature()).toBe(rollback ? "before" : "after");
    if (rollback) {
      expect(await observation.read()).toEqual(before);
    } else {
      await observation.update(signaturePatch("stale"), before);
      expect(signature()).toBe("after");
    }
  },
);

it("retains its captured database after an environment change", async () => {
  const { deps, configPath, capture, setSignature } = fixture();
  const planning = capture();
  expect(await planning.read()).not.toBeNull();
  deps.env.OPENCLAW_STATE_DIR = directories.make("openclaw-other-health-store-");
  setSignature("other-store");
  const retained = (await planning.read()).state.entries?.[configPath];
  expect(retained).toMatchObject(signaturePatch("before"));
});

it("isolates sibling health rows and async observations from sync observation", async () => {
  const { deps, snapshot, observe, setSignature } = await snapshotFixture();
  const siblingPath = path.join(deps.env.HOME, "sibling.json");
  const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  setSignature("sibling-before", siblingPath);
  const { observation: sibling, before } = await observe(siblingPath);
  expect(before?.basis?.[siblingPath]).toBeDefined();

  now.mockReturnValue(1_700_000_000_001);
  observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
  expect(() => sibling.assertCurrent()).not.toThrow();
  expect((await sibling.read())?.basis?.[siblingPath]).toEqual(before.basis?.[siblingPath]);
  await sibling.update(signaturePatch("sibling-after"), before);
  await closeDatabase();
  expect(readHealth(deps).entries?.[siblingPath]).toMatchObject(signaturePatch("sibling-after"));
});

it("preserves worker-updated fields omitted by a stale sync observation", async () => {
  const { deps, configPath, raw, snapshot, entry, observe } = await snapshotFixture();
  const priorState = readHealth(deps);
  const promoted = createConfigHealthFingerprint({
    raw,
    parsed: snapshot.parsed,
    stat: fs.statSync(configPath),
  });
  const { observation, before } = await observe();
  await observation.update({ lastPromotedGood: promoted }, before);
  const committed = entry()?.lastPromotedGood;
  expect(committed).toEqual(promoted);

  const read = vi
    .spyOn(healthOwner, "readConfigHealthStateFromStore")
    .mockReturnValueOnce(priorState);
  observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
  read.mockRestore();
  await closeDatabase();
  const after = entry();
  expect(after?.lastKnownGood?.hash).toBe(promoted.hash);
  expect(after?.lastPromotedGood).toEqual(committed);
});

it.each(["read", "update"] as const)(
  "rejects retired database admission during health %s",
  async (operation) => {
    const { deps, observe, signature } = fixture();
    const { observation, before } = await observe();
    await closeDatabase();
    await expect(
      operation === "read"
        ? observation.read()
        : observation.update(signaturePatch("stale"), before),
    ).rejects.toThrow("read admission");
    expect(deps.logger.warn).not.toHaveBeenCalled();
    expect(signature()).toBe("before");
  },
);

it("keeps a confirmed health write successful when its database is then closed", async () => {
  const { deps, observe, signature } = fixture();
  const { observation, before } = await observe();
  const execute = sharedWorker.runOpenClawStateWorkerOperation;
  let applied: unknown;
  vi.spyOn(sharedWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(execute, {
      async apply(target, receiver, args) {
        const result: unknown = await Reflect.apply(target, receiver, args);
        applied = result;
        await closeDatabase();
        return result;
      },
    }),
  );
  await observation.update(signaturePatch("committed"), before);
  expect(applied).toBe(true);
  expect(deps.logger.warn).not.toHaveBeenCalled();
  expect(signature()).toBe("committed");
});
