import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createUpdateRun } from "../update-run-ledger.js";
import type {
  UpgradeRecipeStepBinding,
  UpgradeRecipeStepObservation,
  UpgradeRecipeStepWriteInput,
} from "./receipts-contract.js";
import {
  readUpgradeRecipeStepReceiptInDatabase,
  recordUpgradeRecipeStepInWorker,
} from "./receipts-store.js";
import { createFencedUpgradeRecipeStepReceiptRecorder } from "./receipts-worker.js";
import {
  createUpgradeRecipeStepReceiptRecorder,
  type UpgradeRecipeStepReceiptPort,
} from "./receipts.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(closeOpenClawStateDatabaseForTest);
function fixture() {
  const root = dirs.make("recipe-step-receipts-");
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const database = openOpenClawStateDatabase(options);
  const run = createUpdateRun({ trigger: "cli" }, options);
  const binding: UpgradeRecipeStepBinding = {
    protocol: 1,
    runId: run.runId,
    planDigest: "a".repeat(64),
    stepId: "migrate-config",
    recipeId: "historical-config",
    recipeRevision: 1,
    adapterId: "doctor-config",
    adapterRevision: 2,
    adapterArtifactDigest: "b".repeat(64),
    phase: "quiesced-migrate",
    resources: [
      {
        resourceKey: "configuration:profile",
        identityDigest: "c".repeat(64),
        beforeDigest: "d".repeat(64),
        expectedAfterDigest: "e".repeat(64),
        snapshotArtifactDigest: "f".repeat(64),
      },
    ],
  };
  const pathname = database.path;
  closeOpenClawStateDatabaseForTest();
  const writeOptions = { ...options, path: pathname };
  const read = () => {
    const opened = openOpenClawStateDatabase(writeOptions);
    try {
      return readUpgradeRecipeStepReceiptInDatabase(opened.db, binding);
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  };
  const record = (
    input: UpgradeRecipeStepWriteInput,
    guard: (stage: "transaction" | "commit") => void = () => {},
  ) => recordUpgradeRecipeStepInWorker(input, writeOptions, guard);
  const port: UpgradeRecipeStepReceiptPort = {
    assertCurrent: () => {},
    assertEffectsSettled: () => {},
    read: async () => read(),
    record: async (input) => record(input),
  };
  const observation: UpgradeRecipeStepObservation = {
    status: "observed",
    resources: binding.resources.map((item) => ({
      resourceKey: item.resourceKey,
      identityDigest: item.identityDigest,
      stateDigest: item.expectedAfterDigest,
    })),
  };
  return { binding, observation, port, record, read, writeOptions };
}

it("writes and reads exact step evidence through the registered fenced workers", async () => {
  const f = fixture();
  let current = true;
  const recorder = createFencedUpgradeRecipeStepReceiptRecorder(f.binding, {
    ...f.writeOptions,
    assertCurrent: () => {
      if (!current) {
        throw new Error("executor retired");
      }
    },
    assertEffectsSettled: () => {},
  });
  expect((await recorder.prepareIntent()).kind).toBe("intent-recorded");
  expect((await recorder.read())?.phase).toBe("intent");
  expect((await recorder.reconcile(async () => f.observation)).kind).toBe("verified");
  expect((await recorder.read())?.phase).toBe("verified");
  current = false;
  await expect(recorder.read()).rejects.toThrow("executor retired");
});

it("retains exact intent and reconciles a committed migration without running it again", async () => {
  const f = fixture();
  const recorder = createUpgradeRecipeStepReceiptRecorder(f.binding, f.port);
  const prepared = await recorder.prepareIntent();
  expect(prepared.kind).toBe("intent-recorded");
  expect(f.read()?.binding).toEqual(f.binding);
  // The process can die after migration commit and before its completion receipt.
  const resumed = createUpgradeRecipeStepReceiptRecorder(f.binding, f.port);
  expect((await resumed.prepareIntent()).kind).toBe("reconciliation-required");
  const result = await resumed.reconcile(async () => f.observation);
  expect(result.kind).toBe("verified");
  expect(result.receipt.revision).toBe(2);
  expect(result.receipt.intentAtMs).toBe(prepared.receipt.intentAtMs);
  expect(f.read()).toEqual(result.receipt);
  expect(() =>
    f.record({
      kind: "observation",
      binding: f.binding,
      expectedRevision: 2,
      observation: f.observation,
    }),
  ).toThrow(/not admitted/);
});

it("a precondition match or replacement resource cannot turn ambiguous intent into replay permission", async () => {
  const f = fixture();
  const recorder = createUpgradeRecipeStepReceiptRecorder(f.binding, f.port);
  await recorder.prepareIntent();
  const unchanged: UpgradeRecipeStepObservation = structuredClone(f.observation);
  unchanged.resources[0]!.stateDigest = f.binding.resources[0]!.beforeDigest;
  const unknown = await recorder.reconcile(async () => unchanged);
  expect(unknown.kind).toBe("outcome-unknown");
  expect((await recorder.prepareIntent()).kind).toBe("reconciliation-required");
  const replacement = structuredClone(f.observation);
  replacement.resources[0]!.identityDigest = "0".repeat(64);
  expect((await recorder.reconcile(async () => replacement)).kind).toBe("outcome-unknown");
  expect((await recorder.reconcile(async () => f.observation)).kind).toBe("verified");
});

it("changed bindings and stale completions cannot overwrite a retained step", () => {
  const f = fixture();
  const intent = f.record({ kind: "intent", binding: f.binding, expectedRevision: null });
  expect(() => f.record({ kind: "intent", binding: f.binding, expectedRevision: null })).toThrow(
    /receipt changed/,
  );
  expect(() =>
    f.record({
      kind: "observation",
      binding: { ...f.binding, planDigest: "1".repeat(64) },
      expectedRevision: 1,
      observation: f.observation,
    }),
  ).toThrow(/identity changed/);
  expect(() =>
    f.record({
      kind: "observation",
      binding: f.binding,
      expectedRevision: 2,
      observation: f.observation,
    }),
  ).toThrow(/receipt changed/);
  expect(f.read()).toEqual(intent);
});

it("lost commit authority rolls back intent, and lost reply requires read-based reconciliation", async () => {
  const f = fixture();
  expect(() =>
    f.record({ kind: "intent", binding: f.binding, expectedRevision: null }, (stage) => {
      if (stage === "commit") {
        throw new Error("fence lost");
      }
    }),
  ).toThrow("fence lost");
  expect(f.read()).toBeNull();
  const unknownReply = createUpgradeRecipeStepReceiptRecorder(f.binding, {
    ...f.port,
    record: async (input) => {
      f.record(input);
      throw new Error("writer outcome unknown");
    },
  });
  await expect(unknownReply.prepareIntent()).rejects.toThrow("writer outcome unknown");
  expect(f.read()?.phase).toBe("intent");
  const recovered = createUpgradeRecipeStepReceiptRecorder(f.binding, f.port);
  expect((await recovered.prepareIntent()).kind).toBe("reconciliation-required");
});

it("verifies live state again for completed steps without overwriting history or replaying effects", async () => {
  const f = fixture();
  const recorder = createUpgradeRecipeStepReceiptRecorder(f.binding, f.port);
  await recorder.prepareIntent();
  const completed = await recorder.reconcile(async () => f.observation);
  const changed = structuredClone(f.observation);
  changed.resources[0]!.stateDigest = "1".repeat(64);
  const drift = await recorder.reconcile(async () => changed);
  expect(drift.kind).toBe("postcondition-drift");
  expect(drift.receipt).toEqual(completed.receipt);
  expect(f.read()).toEqual(completed.receipt);
});

it("does not verify an unsettled child or publish an observation after losing authority", async () => {
  const f = fixture();
  let live = true;
  const recorder = createUpgradeRecipeStepReceiptRecorder(f.binding, {
    ...f.port,
    assertCurrent: () => {
      if (!live) {
        throw new Error("fence lost");
      }
    },
  });
  await recorder.prepareIntent();
  await expect(
    recorder.reconcile(async () => {
      live = false;
      return f.observation;
    }),
  ).rejects.toThrow("fence lost");
  expect(f.read()?.phase).toBe("intent");
  const unsettled = createUpgradeRecipeStepReceiptRecorder(f.binding, {
    ...f.port,
    assertEffectsSettled: () => {
      throw new Error("child may still commit");
    },
  });
  await expect(unsettled.reconcile(async () => f.observation)).rejects.toThrow(
    "child may still commit",
  );
  expect(f.read()?.phase).toBe("intent");
});
