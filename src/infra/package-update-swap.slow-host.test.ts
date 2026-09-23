import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { swapStagedPackageInstall, type PackageUpdateTransaction } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

afterEach(() => vi.restoreAllMocks());

describe("slow-host package swap", () => {
  it("sizes the scan from inventoried bytes and the first second of host throughput", async () => {
    await withTestDir({ prefix: "openclaw-adaptive-scan-" }, async (base) => {
      const { params, packageRoot } = await createPackageSwapFixture(base);
      const largeFile = path.join(packageRoot, "dist", "large.js");
      await fs.writeFile(largeFile, Buffer.alloc(256 * 1024, 42));
      const open = fs.open.bind(fs);
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if ([path.join(packageRoot, "package.json"), largeFile].includes(String(args[0]))) {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(
            async (...readArgs: Parameters<typeof handle.read>) => {
              const value = await read(...readArgs);
              now += String(args[0]) === largeFile ? 60_000 : 1100;
              return value;
            },
          );
        }
        return handle;
      });
      const result = await swapStagedPackageInstall({ ...params, timeoutMs: 55_000 });
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(result.step.advisory).toBeUndefined();
    });
  });

  it.each([
    "unchanged",
    "corrupted file",
    "hash mismatch",
    "slow recovery",
    "slow recovery hash mismatch",
    "slow recovery identity",
    "slow recovery launcher",
    "unrecorded contents still unavailable",
    "unrecorded metadata still unavailable",
  ] as const)(
    "retains completed hashes after a scan cutoff and guards rollback (%s)",
    async (corrupt) => {
      await withTestDir({ prefix: "openclaw-partial-scan-" }, async (base) => {
        const { params, packageRoot, launcher } = await createPackageSwapFixture(base);
        const runtime = path.join(packageRoot, "dist", "index.js");
        const original = await fs.readFile(runtime, "utf8");
        const originalIdentity = (await fs.stat(packageRoot)).ino;
        const stalled = path.join(packageRoot, "zz-stalled.js");
        await fs.writeFile(stalled, "slow disk\n");
        let now = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const open = fs.open.bind(fs);
        const lstat = fs.lstat.bind(fs);
        let corruptRead: string | undefined;
        let unavailableContents: string | undefined;
        let unavailableMetadata: string | undefined;
        let delayedRecoveryRead: string | undefined;
        let manifestOpens = 0;
        let stalledOnce = false;
        let recoveryDelayed = false;
        let recovering = false;
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (String(args[0]) === unavailableMetadata) {
            throw Object.assign(new Error("Unrecorded metadata is still unavailable"), {
              code: "EIO",
            });
          }
          const stat = await lstat(...args);
          if (
            corrupt === "unrecorded metadata still unavailable" &&
            !stalledOnce &&
            String(args[0]) === stalled
          ) {
            stalledOnce = true;
            now += 120_001;
          }
          return stat;
        });
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (String(args[0]) === unavailableContents) {
            throw Object.assign(new Error("Unrecorded contents are still unavailable"), {
              code: "EIO",
            });
          }
          const handle = await open(...args);
          if (!stalledOnce && String(args[0]) === stalled) {
            stalledOnce = true;
            now += 120_001;
          }
          const delayedManifest = String(args[0]) === delayedRecoveryRead;
          if (delayedManifest) {
            manifestOpens++;
          }
          if (
            recovering &&
            !recoveryDelayed &&
            ((delayedManifest && (corrupt !== "slow recovery identity" || manifestOpens === 3)) ||
              (corrupt === "slow recovery launcher" &&
                String(args[0]).includes(".openclaw.shim-backup-")))
          ) {
            recoveryDelayed = true;
            now += 120_001;
          }
          if (String(args[0]) === corruptRead) {
            const read = handle.read.bind(handle);
            vi.spyOn(handle, "read").mockImplementation(
              async (...readArgs: Parameters<typeof handle.read>) => {
                const value = await read(...readArgs);
                if (Buffer.isBuffer(value.buffer)) {
                  value.buffer.fill(0, 0, value.bytesRead);
                }
                return value;
              },
            );
          }
          return handle;
        });
        let transaction: PackageUpdateTransaction | undefined;
        const result = await swapStagedPackageInstall({
          ...params,
          timeoutMs: 200,
          onTransaction: (value) => {
            transaction = value;
          },
        });
        expect(result.status, result.step.stderrTail ?? "").toBe("committed");
        expect(result.step.advisory?.message).toContain("baseline package fingerprint incomplete");
        expect(updateRunStepsFromResultStep(result.step)).toContainEqual(
          expect.objectContaining({ step: "warning:package-swap", status: "completed" }),
        );
        expect(transaction).toBeDefined();
        const backup = transaction!.backupRoot;
        expect((await fs.stat(backup)).ino).toBe(originalIdentity);
        if (corrupt === "corrupted file") {
          await fs.writeFile(path.join(backup, "dist", "index.js"), "corrupted retained runtime\n");
        }
        if (corrupt.includes("hash mismatch")) {
          // Model a changed read with identical inode/stat values: only the retained hash catches it.
          corruptRead = path.join(backup, "dist", "index.js");
        }
        if (corrupt.startsWith("slow recovery") && corrupt !== "slow recovery launcher") {
          delayedRecoveryRead = path.join(backup, "package.json");
        }
        if (corrupt === "unrecorded contents still unavailable") {
          unavailableContents = path.join(backup, "zz-stalled.js");
        }
        if (corrupt === "unrecorded metadata still unavailable") {
          unavailableMetadata = path.join(backup, "zz-stalled.js");
        }
        recovering = true;
        const restored = await transaction!.rollback(() => {});
        if (corrupt === "corrupted file" || corrupt.includes("hash mismatch")) {
          expect(restored.exitCode).toBe(1);
          expect(restored.stderrTail).toContain("retained package tree changed");
          expect(restored.stderrTail).toContain("dist");
          if (corrupt.includes("hash mismatch")) {
            expect(restored.stderrTail).toContain("content hash mismatch");
          }
          expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
          await expect(fs.stat(backup)).resolves.toBeDefined();
        } else {
          expect(restored.exitCode, restored.stderrTail ?? "").toBe(0);
          if (corrupt.startsWith("slow recovery")) {
            expect(recoveryDelayed).toBe(true);
            expect(restored.advisory?.message).toContain("continuing recorded fingerprint checks");
          }
          expect(await fs.readFile(runtime, "utf8")).toBe(original);
          expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
          expect((await fs.stat(packageRoot)).ino).toBe(originalIdentity);
          expect(
            await transaction!.complete({ activationVerified: false }, () => {}),
          ).toBeUndefined();
        }
      });
    },
  );
});
