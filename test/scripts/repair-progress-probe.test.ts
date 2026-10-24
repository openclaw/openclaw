import fs from "node:fs";
import path from "node:path";
import sqlite, { type DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeRepairProgressIntegrity,
  observeRepairProgressPhases,
  resolveRepairProgressEntrypoint,
} from "../../scripts/e2e/lib/upgrade-survivor/repair-progress-probe.mjs";
import { assertRepairProgressFinalization } from "../../scripts/e2e/lib/upgrade-survivor/repair-progress.mjs";
import { readWorkerCellPackageIdentity } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import {
  assertSqliteIntegrity,
  assertSqliteTableIntegrity,
} from "../../src/infra/sqlite-integrity.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

it("observes real full and quick integrity work without intercepting table checks", () => {
  const observed = vi.fn();
  const restore = observeRepairProgressIntegrity(observed);
  let database: DatabaseSync | undefined;
  try {
    database = new sqlite.DatabaseSync(":memory:");
    database.exec("CREATE TABLE probe(value TEXT)");
    expect(assertSqliteIntegrity(database, "progress probe")).toEqual({ integrityCheck: "ok" });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(
      assertSqliteIntegrity(database, "progress probe", { check: "quick", tables: ["probe"] }),
    ).toEqual({ integrityCheck: "ok" });
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed.mock.calls).toEqual([["integrity_check"], ["quick_check"]]);
    assertSqliteTableIntegrity(database, "progress probe", "probe");
    expect(observed).toHaveBeenCalledTimes(2);
  } finally {
    restore();
    database?.close();
  }
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("observes only native phase sends without changing IPC forwarding or errors", () => {
  const original = Object.getOwnPropertyDescriptor(process, "send");
  const send = vi.fn(function (this: NodeJS.Process) {
    expect(this).toBe(process);
    return false;
  });
  process.send = send;
  const observed = vi.fn();
  const restore = observeRepairProgressPhases(observed);
  try {
    const callback = vi.fn();
    const message = { type: "phase", phase: "checking" };
    expect(process.send(message, callback)).toBe(false);
    expect(send).toHaveBeenCalledWith(message, callback);
    expect(observed).toHaveBeenCalledExactlyOnceWith("checking");
    process.send({ ok: true });
    process.send({ type: "phase", phase: "private-unrecognized-phase" });
    expect(observed).toHaveBeenCalledTimes(1);
    const failure = new Error("native IPC failure");
    send.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => process.send?.(message)).toThrow(failure);
    expect(observed).toHaveBeenCalledTimes(1);
  } finally {
    restore();
    try {
      observed.mockClear();
      expect(process.send({ type: "phase", phase: "opening" })).toBe(false);
      expect(observed).not.toHaveBeenCalled();
    } finally {
      // Restore the optional IPC property without detaching or invoking its method.
      if (original) {
        Object.defineProperty(process, "send", original);
      } else {
        delete process.send;
      }
    }
  }
});

it("ignores lifecycle scripts without relaxing installed runtime identity", () => {
  const root = fs.realpathSync(dirs.make("progress-entry-identity-"));
  fs.mkdirSync(path.join(root, "dist/infra"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.8" }),
  );
  fs.writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "2026.9.8", commit: "a".repeat(40) }),
  );
  const launcher = path.join(root, "openclaw.mjs");
  const worker = path.join(root, "dist/infra/sqlite-integrity.worker.js");
  const lifecycle = path.join(root, "scripts/preinstall-package-manager-warning.mjs");
  for (const file of [launcher, worker, lifecycle]) {
    fs.writeFileSync(file, "export {};\n");
  }
  const expected = readWorkerCellPackageIdentity(root);
  const observed = vi.fn();
  expect(resolveRepairProgressEntrypoint(lifecycle, [expected], observed)).toBeUndefined();
  expect(observed).toHaveBeenLastCalledWith({ gate: "lifecycle-entry" });
  expect(resolveRepairProgressEntrypoint(worker, [], observed)).toBeUndefined();
  expect(observed).toHaveBeenLastCalledWith({
    role: "integrity",
    identityMatched: false,
    gate: "identity-mismatch",
  });
  expect(resolveRepairProgressEntrypoint(launcher, [expected])?.identity.entry).toBe(
    "openclaw.mjs",
  );
  expect(resolveRepairProgressEntrypoint(worker, [expected], observed)?.identity.entry).toBe(
    "dist/infra/sqlite-integrity.worker.js",
  );
  expect(observed).toHaveBeenLastCalledWith({ entryHashMatched: true, gate: "identity-admitted" });
  fs.appendFileSync(worker, "// changed runtime bytes\n");
  expect(() => resolveRepairProgressEntrypoint(worker, [expected], observed)).toThrow();
  expect(observed).toHaveBeenLastCalledWith({ entryHashMatched: false, gate: "entry-mismatch" });
  const unlisted = path.join(root, "dist/unlisted-runtime.js");
  fs.writeFileSync(unlisted, "export {};\n");
  expect(() => resolveRepairProgressEntrypoint(unlisted, [expected])).toThrow();
});

const finalizerProcess = {
  pid: 123,
  ppid: 122,
  at: 20_001,
  migrated: true,
  identity: {
    entry: "dist/infra/update-migrated-finalize.worker.js",
    payload: "frozen-target-payload",
  },
};
const finalizerResult = {
  runId: "actual-update-run",
  steps: [{ name: "update-driver-handoff", exitCode: 0 }],
};

it("accepts native migration followed by the real finalizer without requiring another audit", () => {
  expect(
    assertRepairProgressFinalization({
      processes: [finalizerProcess],
      result: finalizerResult,
      releasedAt: 20_000,
      payload: "frozen-target-payload",
    }),
  ).toMatchObject({
    pid: 123,
    runId: "actual-update-run",
    nativeProgressPhase: "before-finalizer",
  });
});

it.each([
  { name: "missing finalizer", processes: [] },
  { name: "duplicate finalizer", processes: [finalizerProcess, finalizerProcess] },
  { name: "wrong package", payload: "other-payload" },
  { name: "native work still held", releasedAt: 20_002 },
  { name: "missing timestamp", processes: [{ ...finalizerProcess, at: undefined }] },
  { name: "missing run", result: { ...finalizerResult, runId: "" } },
  { name: "missing handoff", result: { ...finalizerResult, steps: [] } },
  {
    name: "failed handoff",
    result: { ...finalizerResult, steps: [{ name: "update-driver-handoff", exitCode: 1 }] },
  },
])("rejects $name instead of passing ordinary update completion as finalization", (invalid) => {
  expect(() =>
    assertRepairProgressFinalization({
      processes: [finalizerProcess],
      result: finalizerResult,
      releasedAt: 20_000,
      payload: "frozen-target-payload",
      ...invalid,
    }),
  ).toThrow();
});
