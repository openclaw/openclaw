import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
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

it.each([false, true])(
  "publishes nested health invalidation only on outer commit (rollback: %s)",
  async (rollback) => {
    const { deps, configPath } = fixture();
    using observation = captureConfigHealthStateStore(deps, configPath);
    const before = await observation.read();
    expect(before?.state.entries?.[configPath]?.lastObservedSuspiciousSignature).toBe("before");
    const abort = new Error("fixture outer rollback");
    const mutate = () =>
      runOpenClawStateWriteTransaction(
        () => {
          patchConfigHealthEntryToStore(deps, configPath, {
            lastObservedSuspiciousSignature: "after",
          });
          expect(observation.isCurrent()).toBe(true);
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
      expect(await observation.read()).toBeNull();
    }
  },
);

it("disposes newer scopes without reviving superseded observations and preserves other paths", async () => {
  const { deps, configPath } = fixture();
  using older = captureConfigHealthStateStore(deps, configPath);
  using otherPath = captureConfigHealthStateStore(deps, path.join(deps.env.HOME, "other.json"));
  expect(older.isCurrent()).toBe(true);
  {
    using newer = captureConfigHealthStateStore(deps, configPath);
    expect(await older.read()).toBeNull();
    expect(await newer.read()).not.toBeNull();
    expect(otherPath.isCurrent()).toBe(true);
  }
  expect(await older.read()).toBeNull();
  expect(await otherPath.read()).not.toBeNull();
});

it("continuations retain their captured database after planning scope disposal", async () => {
  const { deps, configPath } = fixture();
  let continueObservation: () => ReturnType<typeof captureConfigHealthStateStore>;
  {
    using planning = captureConfigHealthStateStore(deps, configPath);
    expect(await planning.read()).not.toBeNull();
    continueObservation = () => planning.captureContinuation();
  }
  deps.env.OPENCLAW_STATE_DIR = directories.make("openclaw-other-health-store-");
  patchConfigHealthEntryToStore(deps, configPath, {
    lastObservedSuspiciousSignature: "other-store",
  });
  using continuation = continueObservation();
  expect(
    (await continuation.read())?.state.entries?.[configPath]?.lastObservedSuspiciousSignature,
  ).toBe("before");
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
  using sibling = captureConfigHealthStateStore(deps, siblingPath);
  const before = await sibling.read();
  expect(before?.basis?.[siblingPath]).toBeDefined();
  if (!before) {
    throw new Error("Expected current sibling observation");
  }

  now.mockReturnValue(1_700_000_000_001);
  observeConfigSnapshotSync(normalizeConfigIoDeps(deps), snapshot);
  expect(sibling.isCurrent()).toBe(true);
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
  using workerObservation = captureConfigHealthStateStore(deps, configPath);
  const basis = await workerObservation.read();
  if (!basis) {
    throw new Error("Expected current worker observation");
  }
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
    using observation = captureConfigHealthStateStore(deps, configPath);
    const before = await observation.read();
    if (!before) {
      throw new Error("Expected current observation");
    }
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
  using observation = captureConfigHealthStateStore(deps, configPath);
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
