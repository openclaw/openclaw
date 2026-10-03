import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import {
  createPackageIntegrityReader,
  PackageIntegrityLimitError,
} from "./package-update-integrity.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "./update-run-timeouts.js";

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.restoreAllMocks();
});

function captureReaderLogs() {
  const records: Array<Record<string, unknown>> = [];
  const capture = (line: string) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.subsystem === "update/package-integrity") {
      records.push(record);
    }
  };
  setLoggerOverride({ level: "silent", consoleLevel: "debug", consoleStyle: "json" });
  loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
  return records;
}

describe("package verification bounds", () => {
  it.each(["settled", "racy", "journal"] as const)(
    "reuses only settled in-process file digests (%s observation)",
    async (observation) => {
      await withTestDir({ prefix: "openclaw-integrity-reuse-" }, async (base) => {
        const clock = Date.now.bind(Date);
        let now = clock();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const { packageRoot } = await createPackageSwapFixture(base);
        const empty = path.join(packageRoot, "empty");
        await fs.writeFile(empty, "");
        if (observation !== "racy") {
          now = clock() + 6_000;
        }
        const hash = interceptPackageFileHashes();
        const hashedFiles = () => hash.mock.calls.map(([file]) => file);
        const open = vi.spyOn(fs, "open");
        const packageOpens = () =>
          open.mock.calls
            .map(([file]) => String(file))
            .filter((file) => file.startsWith(`${packageRoot}${path.sep}`));
        const reader = createPackageIntegrityReader();
        const first = await reader.tree(packageRoot);
        const files = hashedFiles();
        expect(files).toContain(empty);
        expect(new Set(files).size).toBe(files.length);
        hash.mockClear();
        open.mockClear();
        const journal = JSON.stringify(first);
        const reuse = observation === "journal" ? JSON.parse(journal) : first;
        expect(await reader.tree(packageRoot, packageRoot, reuse)).toEqual(first);
        // The version read still opens the manifest once, independently of its digest.
        expect(hashedFiles()).toEqual(observation === "settled" ? [] : files);
        expect(packageOpens()).toEqual([path.join(packageRoot, "package.json")]);
        if (observation === "racy") {
          // Aging alone cannot turn an earlier racy read into settled evidence.
          now = clock() + 6_000;
          hash.mockClear();
          open.mockClear();
          expect(await reader.tree(packageRoot, packageRoot, first)).toEqual(first);
          expect(hashedFiles()).toEqual(files);
          expect(packageOpens()).toEqual([path.join(packageRoot, "package.json")]);
        }
      });
    },
  );

  it.for([1, 4])(
    "rehashes %i changed files in DFS order without charging reused entries a hash slot",
    async (changedCount, { signal }) => {
      await withTestDir({ prefix: "openclaw-integrity-mixed-reuse-" }, async (base) => {
        const { packageRoot } = await createPackageSwapFixture(base);
        const files = Array.from({ length: 4 }, (_, index) =>
          path.join(packageRoot, "dist", `reuse-${index}-a.js`),
        );
        for (const file of files) {
          await fs.writeFile(file, "before");
          await fs.writeFile(file.replace("-a.js", "-b.js"), "");
        }
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6_000);
        const reader = createPackageIntegrityReader();
        const first = await reader.tree(packageRoot);
        const changed = files.slice(0, changedCount);
        for (const file of changed) {
          await fs.writeFile(file, "changed content");
        }
        const release = createDeferredCore();
        const admitted = createDeferredCore();
        const hashed: string[] = [];
        const hash = interceptPackageFileHashes(async (file, _stat, next) => {
          hashed.push(file);
          // Queue real work before blocking its result so flush owns every job.
          const hashing = next();
          if (changed.includes(file)) {
            if (hashed.length === changed.length) {
              admitted.resolve();
            }
            await release.promise;
          }
          return hashing;
        });
        const open = vi.spyOn(fs, "open");
        const walking = reader.tree(packageRoot, packageRoot, first);
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              admitted.promise,
              walking,
              "The walk settled before admitting its changed files",
            ),
            signal,
          );
          release.resolve();
          const second = await withinTest(walking, signal);
          expect(hashed).toEqual(changed);
          expect(open.mock.calls.map(([file]) => String(file))).toEqual([
            path.join(packageRoot, "package.json"),
          ]);
          expect(second.digest).not.toBe(first.digest);
          open.mockRestore();
          hash.mockImplementation((_file, _stat, next) => next());
          expect(second).toEqual(await reader.tree(packageRoot));
        } finally {
          release.resolve();
          await Promise.allSettled([walking]);
        }
      });
    },
  );

  it("distinguishes entry and byte budget exhaustion from integrity failures", async () => {
    await withTestDir({ prefix: "openclaw-integrity-budget-type-" }, async (base) => {
      const { packageRoot, launcher } = await createPackageSwapFixture(base);
      await expect(createPackageIntegrityReader().entries(packageRoot, 1)).rejects.toBeInstanceOf(
        PackageIntegrityLimitError,
      );
      await fs.truncate(launcher, 1024 * 1024 + 1);
      await expect(createPackageIntegrityReader().launcher(launcher)).rejects.toMatchObject({
        resource: "byte",
      });
      await expect(createPackageIntegrityReader().launcher(packageRoot)).rejects.not.toBeInstanceOf(
        PackageIntegrityLimitError,
      );
    });
  });

  it("preserves an earlier filesystem refusal over aggregate byte exhaustion", async ({
    signal,
  }) => {
    await withTestDir({ prefix: "openclaw-integrity-error-order-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const first = path.join(packageRoot, "dist", "a-first.js");
      const second = path.join(packageRoot, "dist", "b-second.js");
      for (const file of [first, second]) {
        await fs.writeFile(file, "");
        await fs.truncate(file, 600 * 1024 * 1024);
      }
      const secondStat = await fs.lstat(second, { bigint: true });
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation((...args) =>
        String(args[0]) === second && args[1]?.bigint
          ? Promise.resolve(secondStat)
          : lstat(...args),
      );
      const release = createDeferredCore();
      const reading = createDeferredCore();
      const refusal = Object.assign(new Error("earlier package bytes could not be read"), {
        code: "EIO",
      });
      let settled = false;
      const hash = interceptPackageFileHashes(async (file, _stat, next) => {
        if (file === second) {
          throw new Error("The aggregate byte limit admitted another package file");
        }
        if (file !== first) {
          return next();
        }
        reading.resolve();
        try {
          await release.promise;
          throw refusal;
        } finally {
          settled = true;
        }
      });
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const onTransaction = vi.fn();
      const update = swapStagedPackageInstall({
        ...params,
        beforeActivate,
        onLiveMutation,
        onTransaction,
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            reading.promise,
            update,
            "The later resource limit replaced a still-owned package read",
          ),
          signal,
        );
        release.resolve();
        const result = await withinTest(update, signal);
        expect(result.status).toBe("failed");
        expect(result.step.stderrTail).toContain(refusal.message);
        expect(result.step.stderrTail).not.toContain("byte limit exceeded");
        expect(result.step.advisory).toBeUndefined();
        expect(settled).toBe(true);
        expect(hash.mock.calls.some(([file]) => file === second)).toBe(false);
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(onLiveMutation).not.toHaveBeenCalled();
        expect(onTransaction).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
        expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
      } finally {
        release.resolve();
        await update;
      }
    });
  });

  it.each([
    { timeoutMs: 55_000, elapsedMs: 31_000, incomplete: false },
    { timeoutMs: 55_000, elapsedMs: 55_001, incomplete: true },
    { timeoutMs: 1_800_000, elapsedMs: 300_001, incomplete: false },
    { timeoutMs: 1_800_000, elapsedMs: 1_800_001, incomplete: true },
    { timeoutMs: 200, elapsedMs: 201, incomplete: true },
  ])(
    "bounds a $elapsedMs ms baseline scan by a $timeoutMs ms caller budget",
    async ({ timeoutMs, elapsedMs, incomplete }) => {
      await withTestDir({ prefix: "openclaw-baseline-budget-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const lstat = fs.lstat.bind(fs);
        let delayed = false;
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (!delayed && String(args[0]) === path.join(packageRoot, "dist", "index.js")) {
            delayed = true;
            // Advance the deadline clock during a real tree walk, without a long wall-clock wait.
            now += elapsedMs;
          }
          return stat;
        });
        const beforeActivate = vi.fn();
        const result = await swapStagedPackageInstall({ ...params, timeoutMs, beforeActivate });
        expect(delayed).toBe(true);
        expect(result.status, result.step.stderrTail ?? "").toBe("committed");
        expect(beforeActivate).toHaveBeenCalledOnce();
        expect(Boolean(result.step.advisory)).toBe(incomplete);
        if (incomplete) {
          expect(result.step.advisory?.message).toContain(
            "baseline package fingerprint incomplete",
          );
        }
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
      });
    },
  );

  it.each([
    { phase: "retained", corrupt: false, timeoutMs: undefined, restored: true },
    { phase: "retained", corrupt: false, timeoutMs: 120_000, restored: true },
    { phase: "restored", corrupt: false, timeoutMs: 120_000, restored: true },
    { phase: "retained", corrupt: true, timeoutMs: 120_000, restored: false },
    { phase: "retained", corrupt: false, timeoutMs: 20_000, restored: false },
  ])(
    "uses the caller budget for $phase verification (corrupt=$corrupt, budget=$timeoutMs)",
    async ({ phase, corrupt, timeoutMs, restored }) => {
      await withTestDir({ prefix: "openclaw-recovery-budget-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const runtime = path.join(packageRoot, "dist", "index.js");
        const original = await fs.readFile(runtime, "utf8");
        const transactions: PackageUpdateTransaction[] = [];
        const activated = await swapStagedPackageInstall({
          ...params,
          timeoutMs,
          onTransaction: (transaction) => {
            transactions.push(transaction);
          },
        });
        expect(activated.status).toBe("committed");
        expect(activated.step.advisory).toBeUndefined();
        const transaction = transactions[0];
        if (!transaction) {
          throw new Error("Missing retained package transaction");
        }
        const retained = path.join(transaction.backupRoot, "dist", "index.js");
        if (corrupt) {
          const before = await fs.stat(retained);
          await fs.writeFile(retained, "changed runtime; unchanged package version");
          expect((await fs.stat(retained)).ino).toBe(before.ino);
        }
        const target = phase === "retained" ? retained : runtime;
        const now = Date.now.bind(Date);
        const lstat = fs.lstat.bind(fs);
        let elapsed = 0;
        vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (elapsed === 0 && String(args[0]) === target) {
            elapsed = 31_000;
          }
          return stat;
        });
        const result = await transaction.rollback(() => {});
        expect(elapsed).toBe(31_000);
        expect(result.exitCode, result.stderrTail ?? "").toBe(restored ? 0 : 1);
        if (restored) {
          expect(await fs.readFile(runtime, "utf8")).toBe(original);
          expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
        } else {
          expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
          await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
        }
      });
    },
  );

  it.for(
    (
      ["activation", "rollback", "changed identity", "changed version", "launcher limit"] as const
    ).flatMap((outcome) => (["time", "byte"] as const).map((budget) => ({ outcome, budget }))),
  )(
    "handles $outcome after the baseline fingerprint exhausts its $budget budget",
    async ({ outcome, budget }, { signal }) => {
      await withTestDir({ prefix: "openclaw-fingerprint-advisory-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const original = await fs.stat(packageRoot);
        if (outcome === "launcher limit") {
          await fs.truncate(launcher, 1024 * 1024 + 1);
        }
        const blocked = createDeferredCore();
        const started = createDeferredCore();
        let entered = false;
        if (budget === "byte") {
          const payload = path.join(packageRoot, "runtime-payload.bin");
          await fs.writeFile(payload, "");
          await fs.truncate(payload, 1024 * 1024 * 1024 + 1);
        } else {
          interceptPackageFileHashes(async (file, _stat, next) => {
            if (!entered && file === path.join(packageRoot, "dist", "index.js")) {
              entered = true;
              started.resolve();
              await blocked.promise;
              // The deadline has abandoned this intercepted job before it reports.
              return "late hash result";
            }
            return next();
          });
        }
        let transaction: PackageUpdateTransaction | undefined;
        const beforeActivate = vi.fn();
        // Reader budgets run on the wall clock. Freeze it so host load cannot expire the
        // launcher capture or a later reader; only the stalled baseline spends its budget.
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const update = swapStagedPackageInstall({
          ...params,
          ...(budget === "time" ? { timeoutMs: 200 } : {}),
          beforeActivate,
          onTransaction: (value) => {
            transaction = value;
          },
        });
        try {
          if (budget === "time") {
            await withinTest(
              awaitGateBeforeSettlement(
                started.promise,
                update,
                "Baseline fingerprint settled before its walk stalled",
              ),
              signal,
            );
            await vi.advanceTimersByTimeAsync(200);
          }
          const result = await withinTest(update, signal);
          expect(entered).toBe(budget === "time");
          if (outcome === "launcher limit") {
            expect(result.status).toBe("failed");
            expect(result.step.stderrTail).toContain("byte limit exceeded");
            expect(result.step.stderrTail).not.toContain("Baseline package scan failed");
            expect(beforeActivate).not.toHaveBeenCalled();
            expect((await fs.stat(packageRoot)).ino).toBe(original.ino);
            return;
          }
          expect(result.status, result.step.stderrTail ?? "").toBe("committed");
          expect(beforeActivate).toHaveBeenCalledOnce();
          expect(result.step.advisory?.message).toContain(
            "baseline package fingerprint incomplete",
          );
          expect(result.step.advisory?.message).toContain("full package contents are unverified");
          expect(updateRunStepsFromResultStep(result.step)).toContainEqual(
            expect.objectContaining({ step: "warning:package-swap", status: "completed" }),
          );
          expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
          if (!transaction) {
            throw new Error("Missing package transaction");
          }
          if (outcome === "changed identity" || outcome === "changed version") {
            if (outcome === "changed identity") {
              const originalRoot = `${transaction.backupRoot}.original`;
              await fs.rename(transaction.backupRoot, originalRoot);
              await fs.mkdir(transaction.backupRoot);
              // Replace only the root identity without copying the large sparse payload.
              for (const name of await fs.readdir(originalRoot)) {
                await fs.rename(
                  path.join(originalRoot, name),
                  path.join(transaction.backupRoot, name),
                );
              }
            } else {
              await fs.writeFile(
                path.join(transaction.backupRoot, "package.json"),
                '{"version":"3.0.0"}',
              );
            }
            const refused = await transaction.rollback(() => {});
            expect(refused.exitCode).toBe(1);
            expect(refused.advisory).toBeUndefined();
            expect(refused.stderrTail).toContain("retained package tree changed");
            expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
            await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
            return;
          }
          if (outcome === "rollback") {
            const restored = await transaction.rollback(() => {});
            expect(restored).toMatchObject({ exitCode: 0, activePackageRoot: packageRoot });
            expect(restored.advisory?.message).toContain("fingerprint verification unavailable");
            expect(restored.stderrTail ?? "").not.toMatch(/unverified|verification failed/);
            expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
            expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
              '"version":"1.0.0"',
            );
            const actual = await fs.stat(packageRoot);
            expect([actual.dev, actual.ino]).toEqual([original.dev, original.ino]);
          }
          expect(
            await transaction.complete({ activationVerified: outcome === "activation" }, () => {}),
          ).toBeUndefined();
        } finally {
          blocked.resolve();
          vi.useRealTimers();
        }
      });
    },
  );

  it("rejects manifest growth past the byte limit without an oversized metadata allocation", async () => {
    const size = 1024 * 1024 + 1;
    await withTestDir({ prefix: "openclaw-rollback-metadata-bound-" }, async (base) => {
      const { params, packageRoot } = await createPackageSwapFixture(base);
      const manifest = path.join(packageRoot, "package.json");
      const open = fs.open.bind(fs);
      let manifestOpens = 0;
      let grew = false;
      let oversizedRead = false;
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]) !== manifest) {
          return handle;
        }
        if (++manifestOpens === 1) {
          await fs.truncate(manifest, size);
          grew = true;
        }
        // The first main-thread open is the bounded manifest read, after hashing.
        const rejectOversizedRead = async () => {
          oversizedRead = true;
          throw new Error("oversized metadata allocation intercepted");
        };
        vi.spyOn(handle, "readFile").mockImplementation(rejectOversizedRead);
        vi.spyOn(handle, "read").mockImplementation(rejectOversizedRead);
        return handle;
      });
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({
        ...params,
        beforeActivate,
        onLiveMutation,
      });
      expect(grew).toBe(true);
      expect(result.status).toBe("failed");
      expect(oversizedRead).toBe(false);
      expect(beforeActivate).not.toHaveBeenCalled();
      expect(onLiveMutation).not.toHaveBeenCalled();
    });
  });

  it("accepts a valid manifest at the metadata byte limit", async () => {
    await withTestDir({ prefix: "openclaw-rollback-metadata-valid-" }, async (base) => {
      const { params, packageRoot } = await createPackageSwapFixture(base);
      const manifest = path.join(packageRoot, "package.json");
      const contents = await fs.readFile(manifest, "utf8");
      await fs.writeFile(manifest, contents.padEnd(1024 * 1024, " "));
      const observations = captureReaderLogs();
      const transactions: PackageUpdateTransaction[] = [];
      const result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (transaction) => {
          transactions.push(transaction);
        },
      });
      expect(result.status).toBe("committed");
      expect(transactions).toHaveLength(1);
      expect((await transactions[0]!.rollback(() => {})).exitCode).toBe(0);
      await expect(fs.readFile(manifest, "utf8")).resolves.toHaveLength(1024 * 1024);
      const finished = observations.filter((record) => record.event === "reader-settled");
      expect(finished.map((record) => record.phase)).toEqual([
        "baseline",
        "baseline",
        "retained",
        "restored",
      ]);
      expect(new Set(finished.map((record) => record.readerId)).size).toBe(4);
      for (const record of finished) {
        expect(record).toMatchObject({
          outcome: "completed",
          budgetMs: UPDATE_RUNNER_TIMEOUT_MS,
          pendingIo: 0,
        });
        expect(record.timeoutObservedAtMonotonicMs).toBeUndefined();
        expect(Number(record.elapsedMs)).toBeGreaterThan(0);
      }
    });
  });

  it.each(["package", "launcher", "launcher directory"] as const)(
    "bounds the initial %s observation",
    async (entry) => {
      await withTestDir({ prefix: "openclaw-rollback-presence-bound-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const lstat = fs.lstat.bind(fs);
        const readdir = fs.readdir.bind(fs);
        const opendir = fs.opendir.bind(fs);
        const blocked = createDeferredCore();
        const target =
          entry === "package"
            ? packageRoot
            : entry === "launcher"
              ? launcher
              : params.stage.layout.binDir;
        let entered = false;
        const block = async (file: unknown) => {
          if (!entered && String(file) === target) {
            entered = true;
            await blocked.promise;
          }
        };
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          await block(args[0]);
          return lstat(...args);
        });
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          await block(args[0]);
          return readdir(...args);
        });
        vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
          await block(args[0]);
          return opendir(...args);
        });
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const update = swapStagedPackageInstall({
          ...params,
          beforeActivate,
          onLiveMutation,
          timeoutMs: 200,
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            update,
            new Promise<"pending">((resolve) => {
              timer = setTimeout(() => resolve("pending"), 750);
            }),
          ]);
          expect(entered).toBe(true);
          expect(result).toMatchObject({ status: "failed" });
          expect(beforeActivate).not.toHaveBeenCalled();
          expect(onLiveMutation).not.toHaveBeenCalled();
        } finally {
          clearTimeout(timer);
          blocked.resolve();
          await update;
        }
      });
    },
  );

  it.for(["queued hash", "hash report"] as const)(
    "settles bounded parallel hashes after a stalled %s without continuing the walk",
    async (operation, { signal }) => {
      await withTestDir({ prefix: "openclaw-rollback-deadline-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const window = 64;
        const full = createDeferredCore();
        const files = [
          path.join(packageRoot, "dist", "index.js"),
          ...Array.from({ length: window }, (_, index) =>
            path.join(packageRoot, "dist", `peer-${String(index).padStart(3, "0")}.js`),
          ),
        ];
        for (const file of files.slice(1)) {
          await fs.writeFile(file, "export default 1;\n");
        }
        const jobs = new Map(
          files.map((file) => [
            file,
            { release: createDeferredCore(), settled: createDeferredCore() },
          ]),
        );
        const admitted: string[] = [];
        const started: Promise<string>[] = [];
        interceptPackageFileHashes(async (file, _stat, next) => {
          const job = jobs.get(file);
          if (!job || admitted.includes(file)) {
            return next();
          }
          admitted.push(file);
          // Exercise both work not yet started and a completed real hash whose
          // report is delayed. The worker test owns mid-syscall descriptor proof.
          const result = operation === "hash report" ? next() : Promise.resolve("late hash result");
          started.push(result);
          if (admitted.length === window) {
            full.resolve();
          }
          try {
            const value = await result;
            await job.release.promise;
            return value;
          } finally {
            job.settled.resolve();
          }
        });
        const lstat = vi.spyOn(fs, "lstat");
        const beforeActivate = vi.fn();
        const onLiveMutation = vi.fn();
        const observations = captureReaderLogs();
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const update = swapStagedPackageInstall({
          ...params,
          beforeActivate,
          onLiveMutation,
          timeoutMs: 40,
        });
        try {
          await withinTest(
            awaitGateBeforeSettlement(full.promise, update, "the admission window never filled"),
            signal,
          );
          await withinTest(Promise.all(started), signal);
          expect(admitted).toEqual(files.slice(0, window));
          expect(lstat.mock.calls.some(([file]) => String(file) === files[window])).toBe(false);
          await vi.advanceTimersByTimeAsync(40);
          const result = await withinTest(update, signal);
          expect(result.status).toBe("committed");
          expect(result.step.advisory?.message).toContain(
            "baseline package fingerprint incomplete",
          );
          expect(beforeActivate).toHaveBeenCalledOnce();
          expect(onLiveMutation).toHaveBeenCalledOnce();
          expect(admitted).toEqual(files.slice(0, window));
          const baseline = observations.filter(
            (record) => record.readerId === observations[0]?.readerId,
          );
          expect(baseline).toHaveLength(2);
          const [begin, settled] = baseline;
          expect(begin).toMatchObject({ event: "reader-started", budgetMs: 40 });
          expect(settled).toMatchObject({
            event: "reader-settled",
            readerId: begin!.readerId,
            outcome: "timed-out",
            budgetMs: 40,
            deadlineClock: "wall",
          });
          expect(Number(settled!.pendingIo)).toBeGreaterThanOrEqual(window);
          expect(settled!.deadlineAtUnixMs).toBe(begin!.deadlineAtUnixMs);
          expect(settled!.elapsedMs).toBe(
            Number(settled!.settledAtMonotonicMs) - Number(begin!.startedAtMonotonicMs),
          );
          expect(Number(settled!.timeoutObservedAtMonotonicMs)).toBeLessThanOrEqual(
            Number(settled!.settledAtMonotonicMs),
          );
          for (const file of admitted) {
            jobs.get(file)!.release.resolve();
          }
          await withinTest(
            Promise.all(admitted.map((file) => jobs.get(file)!.settled.promise)),
            signal,
          );
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
        } finally {
          for (const job of jobs.values()) {
            job.release.resolve();
          }
          vi.useRealTimers();
          await update;
        }
      });
    },
  );

  it("preserves the primary refusal when reader diagnostics fail", async () => {
    await withTestDir({ prefix: "openclaw-rollback-diagnostics-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      captureReaderLogs();
      const sink = vi.fn(() => {
        throw new Error("diagnostics sink failed");
      });
      loggingState.rawConsole = { log: sink, info: sink, warn: sink, error: sink };
      const hash = interceptPackageFileHashes(async () => {
        throw new Error("reader unavailable");
      });
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({ ...params, beforeActivate, onLiveMutation });
      expect(sink).toHaveBeenCalled();
      expect(hash).toHaveBeenCalled();
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).toContain("reader unavailable");
      expect(result.step.stderrTail).not.toContain("diagnostics sink failed");
      expect(beforeActivate).not.toHaveBeenCalled();
      expect(onLiveMutation).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
    });
  });

  it("records a cleanup-only deadline without claiming successful reader completion", async ({
    signal,
  }) => {
    await withTestDir({ prefix: "openclaw-rollback-close-deadline-" }, async (base) => {
      const { params } = await createPackageSwapFixture(base);
      await fs.unlink(path.join(params.stage.layout.binDir, "openclaw"));
      const observations = captureReaderLogs();
      const release = createDeferredCore();
      const entered = createDeferredCore();
      let closing: Promise<void> | undefined;
      const opendir = fs.opendir.bind(fs);
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        const directory = await opendir(...args);
        if (String(args[0]) === params.stage.layout.binDir) {
          const resource: { close(): Promise<void> } = directory;
          const close = resource.close.bind(resource);
          vi.spyOn(resource, "close").mockImplementation(() => {
            closing = release.promise.then(() => close());
            entered.resolve();
            return closing;
          });
        }
        return directory;
      });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const update = swapStagedPackageInstall({ ...params, timeoutMs: 40 });
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, update, "directory cleanup never started"),
          signal,
        );
        await vi.advanceTimersByTimeAsync(40);
        const result = await withinTest(update, signal);
        // Preserve the existing best-effort close policy, but report its timeout.
        expect(result.status).toBe("committed");
        expect(observations.findLast((record) => record.event === "reader-settled")).toMatchObject({
          phase: "baseline",
          outcome: "timed-out",
          pendingIo: 1,
          timeoutObservedAtMonotonicMs: expect.any(Number),
        });
      } finally {
        release.resolve();
        await closing;
        vi.useRealTimers();
        await update;
      }
    });
  });

  it.each([
    { shape: "single directory", width: 50_000 },
    { shape: "nested directories", width: 30_000 },
  ])("bounds the whole-tree inventory across $shape", async ({ width }) => {
    await withTestDir({ prefix: "openclaw-rollback-entry-bound-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const nested = path.join(packageRoot, "dist");
      const rootChild = (await fs.readdir(packageRoot, { withFileTypes: true })).find(
        (entry) => entry.name === "dist",
      )!;
      const [nestedChild] = await fs.readdir(nested, { withFileTypes: true });
      const opendir = fs.opendir.bind(fs);
      let discovered = 0;
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        const directory = await opendir(...args);
        if (![packageRoot, nested].includes(String(args[0]))) {
          return directory;
        }
        const child = String(args[0]) === packageRoot ? rootChild : nestedChild!;
        // Model wide inventories without allocating their contents on disk.
        const promiseReader: { read(): Promise<typeof child | null> } = directory;
        let returned = 0;
        vi.spyOn(promiseReader, "read").mockImplementation(async () => {
          if (returned++ >= width) {
            return null;
          }
          discovered++;
          return child;
        });
        return directory;
      });
      const hash = interceptPackageFileHashes();
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({
        ...params,
        beforeActivate,
        onLiveMutation,
        timeoutMs: 5000,
      });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(beforeActivate).toHaveBeenCalledOnce();
      expect(onLiveMutation).toHaveBeenCalledOnce();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
      // Includes one overflow entry; the root itself consumes the other slot.
      expect(discovered).toBeLessThanOrEqual(50_000);
      expect(result.step.advisory?.message).toContain("entry limit exceeded");
      expect(hash.mock.calls.some(([file]) => file === path.join(nested, "index.js"))).toBe(false);
    });
  });
});
