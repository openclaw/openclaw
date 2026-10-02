import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createPackageIntegrityReader,
  PackageIntegrityLimitError,
} from "./package-update-integrity.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
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
      const realOpen = fs.open.bind(fs);
      let firstHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
      let closed = false;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]) === second) {
          throw new Error("The aggregate byte limit admitted another package file");
        }
        const handle = await realOpen(...args);
        if (String(args[0]) === first) {
          firstHandle = handle;
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            closed = true;
          });
          vi.spyOn(handle, "read").mockImplementation(async () => {
            reading.resolve();
            await release.promise;
            throw refusal;
          });
        }
        return handle;
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
        expect(closed).toBe(true);
        expect(open.mock.calls.some(([file]) => String(file) === second)).toBe(false);
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
        await firstHandle?.close();
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
        const open = fs.open.bind(fs);
        let elapsed = 0;
        vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (elapsed === 0 && String(args[0]) === target) {
            elapsed = 31_000;
          }
          return open(...args);
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

  it.each(
    (
      ["activation", "rollback", "changed identity", "changed version", "launcher limit"] as const
    ).flatMap((outcome) => (["time", "byte"] as const).map((budget) => ({ outcome, budget }))),
  )(
    "handles $outcome after the baseline fingerprint exhausts its $budget budget",
    async ({ outcome, budget }) => {
      await withTestDir({ prefix: "openclaw-fingerprint-advisory-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const original = await fs.stat(packageRoot);
        if (outcome === "launcher limit") {
          await fs.truncate(launcher, 1024 * 1024 + 1);
        }
        const open = fs.open.bind(fs);
        const blocked = createDeferredCore();
        let entered = false;
        if (budget === "byte") {
          const payload = path.join(packageRoot, "runtime-payload.bin");
          await fs.writeFile(payload, "");
          await fs.truncate(payload, 1024 * 1024 * 1024 + 1);
        } else {
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            if (!entered && String(args[0]) === path.join(packageRoot, "dist", "index.js")) {
              entered = true;
              await blocked.promise;
            }
            return open(...args);
          });
        }
        let transaction: PackageUpdateTransaction | undefined;
        const beforeActivate = vi.fn();
        try {
          const result = await swapStagedPackageInstall({
            ...params,
            ...(budget === "time" ? { timeoutMs: 200 } : {}),
            beforeActivate,
            onTransaction: (value) => {
              transaction = value;
            },
          });
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
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            await fs.truncate(manifest, size);
            grew = true;
          });
        } else {
          // Intercept either read path before buffering an oversized sparse file.
          const rejectOversizedRead = async () => {
            oversizedRead = true;
            throw new Error("oversized metadata allocation intercepted");
          };
          vi.spyOn(handle, "readFile").mockImplementation(rejectOversizedRead);
          vi.spyOn(handle, "read").mockImplementation(rejectOversizedRead);
        }
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

  it.for(["open", "read"] as const)(
    "settles bounded parallel hashes after stalled %s without continuing the walk",
    async (operation, { signal }) => {
      await withTestDir({ prefix: "openclaw-rollback-deadline-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const realOpen = fs.open.bind(fs);
        const firstEntered = createDeferredCore();
        const files = [
          path.join(packageRoot, "dist", "index.js"),
          ...Array.from({ length: 4 }, (_, index) =>
            path.join(packageRoot, "dist", `peer-${index}.js`),
          ),
        ];
        for (const file of files.slice(1)) {
          await fs.writeFile(file, "export default 1;\n");
        }
        const entries = new Map(
          await Promise.all(
            files.map(async (file) => {
              const handle = await realOpen(file, "r");
              const stat = await handle.stat({ bigint: true });
              const late = createDeferredCore<typeof handle>();
              const closed = createDeferredCore();
              const realClose = handle.close.bind(handle);
              const close = vi.spyOn(handle, "close").mockImplementation(async () => {
                await realClose();
                closed.resolve();
              });
              vi.spyOn(handle, "stat").mockResolvedValue(stat);
              const read = vi.spyOn(handle, "read").mockImplementation(() => {
                firstEntered.resolve();
                return new Promise(() => {});
              });
              return [file, { handle, stat, late, closed, realClose, close, read }] as const;
            }),
          ),
        );
        const realLstat = fs.lstat.bind(fs);
        const lstat = vi.spyOn(fs, "lstat").mockImplementation((...args) => {
          const entry = entries.get(String(args[0]));
          return entry && args[1]?.bigint ? Promise.resolve(entry.stat) : realLstat(...args);
        });
        const admitted: string[] = [];
        const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const file = String(args[0]);
          const entry = entries.get(file);
          if (!entry) {
            return realOpen(...args);
          }
          admitted.push(file);
          if (operation === "open") {
            firstEntered.resolve();
            return entry.late.promise;
          }
          return entry.handle;
        });
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
            awaitGateBeforeSettlement(
              firstEntered.promise,
              update,
              "Fingerprinting settled before the owned read stalled",
            ),
            signal,
          );
          await vi.advanceTimersByTimeAsync(40);
          const result = await withinTest(update, signal);
          expect(result.status).toBe("committed");
          expect(result.step.advisory?.message).toContain(
            "baseline package fingerprint incomplete",
          );
          expect(beforeActivate).toHaveBeenCalledOnce();
          expect(onLiveMutation).toHaveBeenCalledOnce();
          expect(admitted).toEqual(files.slice(0, 4));
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
          // A pending close may accompany the stalled read. Neither is a joined OS operation.
          expect(Number(settled!.pendingIo)).toBeGreaterThan(0);
          expect(settled!.deadlineAtUnixMs).toBe(begin!.deadlineAtUnixMs);
          expect(settled!.elapsedMs).toBe(
            Number(settled!.settledAtMonotonicMs) - Number(begin!.startedAtMonotonicMs),
          );
          expect(Number(settled!.timeoutObservedAtMonotonicMs)).toBeLessThanOrEqual(
            Number(settled!.settledAtMonotonicMs),
          );
          if (operation === "open") {
            for (const file of admitted) {
              const entry = entries.get(file)!;
              entry.late.resolve(entry.handle);
            }
          }
          for (const file of admitted) {
            const entry = entries.get(file)!;
            await withinTest(entry.closed.promise, signal);
            expect(entry.close).toHaveBeenCalledTimes(1);
            if (operation === "open") {
              expect(entry.read).not.toHaveBeenCalled();
            }
          }
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("candidate launcher\n");
        } finally {
          for (const entry of entries.values()) {
            entry.late.resolve(entry.handle);
          }
          await vi.advanceTimersByTimeAsync(40);
          open.mockRestore();
          lstat.mockRestore();
          vi.useRealTimers();
          for (const entry of entries.values()) {
            await entry.realClose();
          }
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
      vi.spyOn(fs, "open").mockRejectedValue(new Error("reader unavailable"));
      const beforeActivate = vi.fn();
      const onLiveMutation = vi.fn();
      const result = await swapStagedPackageInstall({ ...params, beforeActivate, onLiveMutation });
      expect(sink).toHaveBeenCalled();
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

  it("records a cleanup-only deadline without claiming successful reader completion", async () => {
    await withTestDir({ prefix: "openclaw-rollback-close-deadline-" }, async (base) => {
      const { params } = await createPackageSwapFixture(base);
      await fs.unlink(path.join(params.stage.layout.binDir, "openclaw"));
      const observations = captureReaderLogs();
      const release = createDeferredCore();
      let closing: Promise<void> | undefined;
      const opendir = fs.opendir.bind(fs);
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        const directory = await opendir(...args);
        if (String(args[0]) === params.stage.layout.binDir) {
          const resource: { close(): Promise<void> } = directory;
          const close = resource.close.bind(resource);
          vi.spyOn(resource, "close").mockImplementation(() => {
            closing = release.promise.then(() => close());
            return closing;
          });
        }
        return directory;
      });
      try {
        const result = await swapStagedPackageInstall({ ...params, timeoutMs: 40 });
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
      const open = vi.spyOn(fs, "open");
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
      expect(open.mock.calls.some(([file]) => String(file) === path.join(nested, "index.js"))).toBe(
        false,
      );
    });
  });
});
