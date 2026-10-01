import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeForTest } from "./package-update-activation-runtime.test-support.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

afterEach(() => vi.restoreAllMocks());

describe("npm rollback content diagnostics", () => {
  it.each([
    "rewrite cache",
    "remove cache",
    "hardlink count",
    "contents",
    "cache symlink",
    "cache during scan",
  ])("verifies retained bytes after %s", async (change) => {
    await withTestDir({ prefix: "openclaw-rollback-diagnostics-" }, async (base) => {
      const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
      const modules = path.join(packageRoot, "node_modules");
      await fs.mkdir(modules);
      await fs.writeFile(path.join(modules, ".package-lock.json"), '{"lockfileVersion":3}');
      let transaction: PackageUpdateTransaction | undefined;
      const swap = await swapStagedPackageInstall({
        ...params,
        onTransaction: (value) => {
          transaction = value;
        },
      });
      expect(swap.status).toBe("committed");
      if (!transaction) {
        throw new Error("missing transaction");
      }
      const cache = path.join(transaction.backupRoot, "node_modules", ".package-lock.json");
      const entry = path.join(transaction.backupRoot, "dist", "index.js");
      if (change === "rewrite cache") {
        await fs.writeFile(`${cache}.replacement`, '{"lockfileVersion":3,"packages":{}}');
        await fs.rename(`${cache}.replacement`, cache);
      } else if (change === "remove cache") {
        await fs.unlink(cache);
      } else if (change === "cache symlink") {
        await fs.unlink(cache);
        await fs.symlink("../dist/index.js", cache);
      } else if (change === "cache during scan") {
        const lstat = fs.lstat.bind(fs);
        let parentReads = 0;
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (String(args[0]) === path.dirname(cache) && ++parentReads === 2) {
            // Replace after the parent's final observation; only the entry recheck can catch it.
            await fs.unlink(cache);
            await fs.symlink("../dist/index.js", cache);
          }
          return stat;
        });
      } else if (change === "hardlink count") {
        await fs.link(entry, path.join(base, "external-hardlink"));
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
      expect(await fs.readFile(launcher, "utf8")).toBe(
        changed ? "candidate launcher\n" : "old launcher\n",
      );
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
  });
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

  it("bounds entry diagnostics through the journaled swap and preserves both packages", async () => {
    const f = await createPackageSwapFixture(root);
    await fixture.writePostCoreCapability(f.params.stage.packageRoot);
    for (let index = 0; index < 6; index++) {
      await fs.writeFile(path.join(f.packageRoot, `drift-${index}.js`), "before");
    }
    await withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(f.packageRoot);
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        ...f.params,
        activation: { fence, runtime: packageActivationRuntimeForTest(), onPrepared: () => {} },
        onTransaction: (value) => {
          transaction = value;
        },
      });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      if (!transaction) {
        throw new Error("missing transaction");
      }
      for (let index = 0; index < 6; index++) {
        await fs.writeFile(path.join(transaction.backupRoot, `drift-${index}.js`), "after!");
      }
      const rollback = await transaction.rollback(fence.assertCurrent);
      expect(rollback.exitCode).toBe(1);
      expect(rollback.failureFacts).toHaveLength(5);
      for (let index = 0; index < 5; index++) {
        expect(rollback.failureFacts?.[index]?.message).toContain(`drift-${index}.js`);
        expect(rollback.failureFacts?.[index]?.message).toContain("sha256");
      }
      expect(rollback.stderrTail).not.toContain("drift-5.js");
      expect(await fs.readFile(f.launcher, "utf8")).toBe("candidate launcher\n");
      expect(
        await fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
      ).toContain('"version":"1.0.0"');
    });
  });
});
