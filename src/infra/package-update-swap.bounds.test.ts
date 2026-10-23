import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import { interceptPackageFileHashes } from "./package-update-integrity-hasher.test-support.js";
import {
  createPackageIntegrityReader,
  PackageIntegrityLimitError,
  PackageIntegrityTimeoutError,
} from "./package-update-integrity.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import {
  captureSwap,
  expectInstallation,
  expectNoCalls,
  expectVersion,
  readText,
  retain,
} from "./package-update-swap.assertions.test-support.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("package verification bounds", () => {
  it("keeps a fresh reader usable after a wall-clock jump forward", async () => {
    await withTestDir({ prefix: "openclaw-integrity-clock-forward-" }, async (base) => {
      const reader = createPackageIntegrityReader(1_000);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
      await expect(reader.entries(base)).resolves.toEqual([]);
    });
  });

  it("expires a read on time despite a wall-clock jump backward", async () => {
    await withTestDir({ prefix: "openclaw-integrity-clock-backward-" }, async (base) => {
      let now = performance.now();
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const reader = createPackageIntegrityReader(15);
      const opendir = fs.opendir.bind(fs);
      vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        const directory = await opendir(...args);
        now += 20;
        return directory;
      });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() - 60_000);
      await expect(reader.entries(base)).rejects.toBeInstanceOf(PackageIntegrityTimeoutError);
    });
  });

  it("rehashes same-tick observations even after they age", async () => {
    await withTestDir({ prefix: "openclaw-integrity-reuse-" }, async (base) => {
      const clock = Date.now.bind(Date);
      let now = clock();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const { packageRoot } = await createPackageSwapFixture(base);
      const empty = path.join(packageRoot, "empty");
      await fs.writeFile(empty, "");
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
      expect(await reader.tree(packageRoot, packageRoot, first)).toEqual(first);
      // The version read still opens the manifest once, independently of its digest.
      expect(hashedFiles()).toEqual(files);
      expect(packageOpens()).toEqual([path.join(packageRoot, "package.json")]);
      // Aging alone cannot turn an earlier racy read into settled evidence.
      now = clock() + 6_000;
      hash.mockClear();
      open.mockClear();
      expect(await reader.tree(packageRoot, packageRoot, first)).toEqual(first);
      expect(hashedFiles()).toEqual(files);
      expect(packageOpens()).toEqual([path.join(packageRoot, "package.json")]);
    });
  });

  it.for([4])(
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
        await fs.truncate(file, 5 * 1024 * 1024 * 1024);
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
        expectNoCalls(beforeActivate, onLiveMutation, onTransaction);
        await expectInstallation(packageRoot, launcher);
      } finally {
        release.resolve();
        await update;
      }
    });
  });

  it.each(["rollback", "changed identity"] as const)(
    "handles %s after the baseline fingerprint exhausts its byte budget",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-fingerprint-advisory-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const original = await fs.stat(packageRoot);
        const payload = path.join(packageRoot, "runtime-payload.bin");
        await fs.writeFile(payload, "");
        await fs.truncate(payload, 8 * 1024 * 1024 * 1024 + 1);
        const beforeActivate = vi.fn();
        const { result, transaction } = await captureSwap({
          ...params,
          beforeActivate,
        });
        expect(result.status, result.step.stderrTail ?? "").toBe("committed");
        expect(beforeActivate).toHaveBeenCalledOnce();
        expect(result.step.advisory?.message).toContain("baseline package fingerprint incomplete");
        expect(result.step.advisory?.message).toContain("full package contents are unverified");
        expect(updateRunStepsFromResultStep(result.step)).toContainEqual(
          expect.objectContaining({ step: "warning:package-swap", status: "completed" }),
        );
        expect(await readText(launcher)).toBe("candidate launcher\n");
        if (outcome === "changed identity") {
          const originalRoot = `${transaction.backupRoot}.original`;
          await fs.rename(transaction.backupRoot, originalRoot);
          await fs.mkdir(transaction.backupRoot);
          // Replace only the root identity without copying the large sparse payload.
          for (const name of await fs.readdir(originalRoot)) {
            await fs.rename(path.join(originalRoot, name), path.join(transaction.backupRoot, name));
          }
          const refused = await transaction.rollback(() => {});
          expect(refused.exitCode).toBe(1);
          expect(refused.advisory).toBeUndefined();
          expect(refused.stderrTail).toContain("retained package tree changed");
          expect(await readText(launcher)).toBe("candidate launcher\n");
          await expect(fs.stat(transaction.backupRoot)).resolves.toBeDefined();
          return;
        }
        const restored = await transaction.rollback(() => {});
        expect(restored).toMatchObject({ exitCode: 0, activePackageRoot: packageRoot });
        expect(restored.advisory?.message).toContain("fingerprint verification unavailable");
        expect(restored.stderrTail ?? "").not.toMatch(/unverified|verification failed/);
        await expectInstallation(packageRoot, launcher);
        const actual = await fs.stat(packageRoot);
        expect([actual.dev, actual.ino]).toEqual([original.dev, original.ino]);
        expect(await transaction.complete({ activationVerified: false }, () => {})).toBeUndefined();
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
      expectNoCalls(beforeActivate, onLiveMutation);
    });
  });

  it("accepts a valid manifest at the metadata byte limit", async () => {
    await withTestDir({ prefix: "openclaw-rollback-metadata-valid-" }, async (base) => {
      const { params, packageRoot } = await createPackageSwapFixture(base);
      const manifest = path.join(packageRoot, "package.json");
      const contents = await fs.readFile(manifest, "utf8");
      await fs.writeFile(manifest, contents.padEnd(1024 * 1024, " "));
      const onTransaction = vi.fn();
      const { result, transaction } = await captureSwap({ ...params, onTransaction });
      expect(result.status).toBe("committed");
      expect(onTransaction).toHaveBeenCalledOnce();
      expect((await transaction.rollback(() => {})).exitCode).toBe(0);
      await expect(fs.readFile(manifest, "utf8")).resolves.toHaveLength(1024 * 1024);
    });
  });

  it.each(["launcher", "launcher directory"] as const)(
    "bounds the initial %s observation",
    async (entry) => {
      await withTestDir({ prefix: "openclaw-rollback-presence-bound-" }, async (base) => {
        const { params, launcher } = await createPackageSwapFixture(base);
        const lstat = fs.lstat.bind(fs);
        const readdir = fs.readdir.bind(fs);
        const opendir = fs.opendir.bind(fs);
        const blocked = createDeferredCore();
        const target = entry === "launcher" ? launcher : params.stage.layout.binDir;
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
          expectNoCalls(beforeActivate, onLiveMutation);
        } finally {
          clearTimeout(timer);
          blocked.resolve();
          await update;
        }
      });
    },
  );

  it.for(["hash report"] as const)(
    "settles bounded parallel hashes after a stalled %s without continuing the walk",
    async (_operation, { signal }) => {
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
          // Delay the real hash report; worker tests own mid-syscall descriptor proof.
          const result = next();
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
        vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
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
          for (const file of admitted) {
            jobs.get(file)!.release.resolve();
          }
          await withinTest(
            Promise.all(admitted.map((file) => jobs.get(file)!.settled.promise)),
            signal,
          );
          await expectInstallation(packageRoot, launcher, true);
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

  it("does not wait beyond the deadline for directory cleanup", async ({ signal }) => {
    await withTestDir({ prefix: "openclaw-rollback-close-deadline-" }, async (base) => {
      const { params } = await createPackageSwapFixture(base);
      await fs.unlink(path.join(params.stage.layout.binDir, "openclaw"));
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
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const update = swapStagedPackageInstall({ ...params, timeoutMs: 40 });
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, update, "directory cleanup never started"),
          signal,
        );
        await vi.advanceTimersByTimeAsync(40);
        const result = await withinTest(update, signal);
        // Cleanup is best effort once the verification deadline expires.
        expect(result.status).toBe("committed");
      } finally {
        release.resolve();
        await closing;
        vi.useRealTimers();
        await update;
      }
    });
  });
});

describe("npm rollback content diagnostics", () => {
  it.each(["rewrite cache", "contents", "cache symlink", "cache during scan"])(
    "verifies retained bytes after %s",
    async (change) => {
      await withTestDir({ prefix: "openclaw-rollback-diagnostics-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const modules = path.join(packageRoot, "node_modules");
        await fs.mkdir(modules);
        await fs.writeFile(path.join(modules, ".package-lock.json"), '{"lockfileVersion":3}');
        const transaction = await retain(params);
        const cache = path.join(transaction.backupRoot, "node_modules", ".package-lock.json");
        const entry = path.join(transaction.backupRoot, "dist", "index.js");
        if (change === "rewrite cache") {
          await fs.writeFile(`${cache}.replacement`, '{"lockfileVersion":3,"packages":{}}');
          await fs.rename(`${cache}.replacement`, cache);
        } else if (change === "cache symlink") {
          await fs.unlink(cache);
          await fs.symlink("../dist/index.js", cache);
        } else if (change === "cache during scan") {
          const lstat = fs.lstat.bind(fs);
          let cacheReads = 0;
          vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
            if (String(args[0]) === cache && ++cacheReads === 2) {
              // Substitute before this entry's recheck, independent of sibling IO order.
              await fs.unlink(cache);
              await fs.symlink("../dist/index.js", cache);
            }
            return lstat(...args);
          });
        } else {
          const before = await fs.stat(entry);
          const contents = await fs.readFile(entry);
          contents.writeUInt8(contents.readUInt8(0) ^ 1, 0);
          await fs.writeFile(entry, contents);
          await fs.utimes(entry, before.atime, before.mtime);
        }
        const rollback = await transaction.rollback(() => {});
        const changed =
          change === "contents" || change === "cache symlink" || change === "cache during scan";
        expect(rollback.exitCode, rollback.stderrTail ?? "").toBe(changed ? 1 : 0);
        expect(await readText(launcher)).toBe(changed ? "candidate launcher\n" : "old launcher\n");
        if (changed && change !== "cache during scan") {
          const name = change === "contents" ? "dist/index.js" : "node_modules/.package-lock.json";
          const steps = updateRunStepsFromResultStep(rollback);
          expect(steps[0]?.failureFacts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ message: expect.stringContaining(name) }),
            ]),
          );
          if (change === "contents") {
            expect(rollback.stderrTail).toContain("sha256");
          }
          const report = await prepareUpdateFailureReport(
            {
              attemptId: "content-drift",
              result: { mode: "npm", status: "error", steps: [], durationMs: 0 },
              recordedRun: { runId: "content-drift", steps },
            },
            { env: {}, stateDir: base },
          );
          expect(report.body).toContain(name);
          expect(report.body).not.toContain(base);
        }
      });
    },
  );
});

describe.skipIf(process.platform === "win32")("managed publication drift facts", () => {
  const fixture = createPackageActivationLifetimeFixture();
  let root: string;
  beforeEach(() => {
    ({ root } = fixture.setup());
  });
  afterEach(async () => {
    try {
      await fixture.lifetime.cleanup();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("bounds ordered drift diagnostics and preserves the journaled fingerprint format", async ({
    signal,
  }) => {
    const f = await createPackageSwapFixture(root);
    await fixture.writePostCoreCapability(f.params.stage.packageRoot);
    for (let index = 0; index < 6; index++) {
      await fs.writeFile(path.join(f.packageRoot, `drift-${index}.js`), "before");
    }
    await fs.mkdir(path.join(f.packageRoot, "nested"));
    await fs.writeFile(path.join(f.packageRoot, "nested", "a.txt"), "nested content");
    await fs.symlink("../drift-0.js", path.join(f.packageRoot, "nested", "link"));
    // Private-mode digests keep the version-1 shape; the oracle names the
    // fixture's postorder explicitly instead of replaying the reader's walk.
    const expectedEntries: Array<[string, "file" | "directory" | "symlink"]> = [
      ["dist/index.js", "file"],
      ["dist/postinstall-content-inventory.json", "file"],
      ["dist/postinstall-inventory.json", "file"],
      ["dist", "directory"],
      ["drift-0.js", "file"],
      ["drift-1.js", "file"],
      ["drift-2.js", "file"],
      ["drift-3.js", "file"],
      ["drift-4.js", "file"],
      ["drift-5.js", "file"],
      ["nested/a.txt", "file"],
      ["nested/link", "symlink"],
      ["nested", "directory"],
      ["package.json", "file"],
      ["", "directory"],
    ];
    const expectedDigest = createHash("sha256");
    for (const [relative, kind] of expectedEntries) {
      const file = path.join(f.packageRoot, relative);
      const stat = await fs.lstat(file, { bigint: true });
      const tuple = [
        `${stat.dev}:${stat.ino}`,
        String(kind === "symlink" ? stat.mode : stat.mode & ~0o077n),
        String(stat.uid),
        String(stat.gid),
      ];
      if (kind !== "directory") {
        tuple.push(String(stat.size), String(stat.mtimeNs), kind);
        tuple.push(
          kind === "symlink"
            ? "../drift-0.js"
            : createHash("sha256")
                .update(await fs.readFile(file))
                .digest("hex"),
        );
      }
      expectedDigest.update(JSON.stringify([relative, tuple]));
    }
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      const { result, transaction } = await captureSwap({
        ...f.params,
        activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
      });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(
        openPackageActivationJournal(resolvePackageActivationAnchor(f.packageRoot)).read()
          .descriptor.previous.digest,
      ).toBe(expectedDigest.digest("hex"));
      const backupRoot = transaction.backupRoot;
      for (let index = 0; index < 6; index++) {
        await fs.writeFile(path.join(backupRoot, `drift-${index}.js`), "after!");
      }
      const hashes = Array.from({ length: 4 }, () => ({
        hashed: createDeferredCore(),
        release: createDeferredCore(),
        completed: createDeferredCore(),
      }));
      const reversed: number[] = [];
      const files = hashes.map((_, index) => path.join(backupRoot, `drift-${index}.js`));
      interceptPackageFileHashes(async (file, _stat, next) => {
        const digest = await next();
        const index = files.indexOf(file);
        if (index >= 0) {
          hashes[index]!.hashed.resolve();
          await hashes[index]!.release.promise;
          reversed.push(index);
          hashes[index]!.completed.resolve();
        }
        return digest;
      });
      const rollingBack = transaction.rollback(fence.assertCurrent);
      let rollback: Awaited<ReturnType<PackageUpdateTransaction["rollback"]>>;
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            Promise.all(hashes.map((hash) => hash.hashed.promise)),
            rollingBack,
            "Rollback settled before its adjacent file hashes completed their byte reads",
          ),
          signal,
        );
        for (const index of [3, 2, 1, 0]) {
          hashes[index]!.release.resolve();
          await withinTest(hashes[index]!.completed.promise, signal);
        }
        rollback = await withinTest(rollingBack, signal);
      } finally {
        for (const hash of hashes) {
          hash.release.resolve();
        }
        await Promise.allSettled([rollingBack]);
      }
      expect(reversed).toEqual([3, 2, 1, 0]);
      expect(rollback.exitCode).toBe(1);
      expect(rollback.failureFacts).toHaveLength(5);
      for (let index = 0; index < 5; index++) {
        expect(rollback.failureFacts?.[index]?.message).toContain(`drift-${index}.js`);
        expect(rollback.failureFacts?.[index]?.message).toContain("sha256");
      }
      expect(rollback.stderrTail).not.toContain("drift-5.js");
      expect(await readText(f.launcher)).toBe("candidate launcher\n");
      await expectVersion(transaction.backupRoot, "1.0.0");
    });
  });
});
