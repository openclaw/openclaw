import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  createPackageIntegrityReader,
  PackageIntegrityTimeoutError,
} from "./package-update-integrity.js";

afterEach(() => vi.restoreAllMocks());

it("verifies a wide package within the deadline on slow storage", async () => {
  await withTestDir({ prefix: "package-integrity-sweep-" }, async (root) => {
    await fs.writeFile(path.join(root, "package.json"), '{"version":"1.0.0"}');
    for (let index = 0; index < 64; index++) {
      await fs.writeFile(path.join(root, `entry-${index}`), "");
    }
    let now = 0;
    let rounds = 0;
    let scheduled: Promise<void> | undefined;
    const observed = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const file = String(args[0]);
      const previous = observed.get(file);
      // rootEntry observes the root once before the tree walk.
      if (previous && file !== root) {
        // All reads admitted in one turn share one simulated storage round trip.
        scheduled ??= setImmediate().then(() => {
          now += 10;
          rounds++;
          scheduled = undefined;
        });
        await scheduled;
        return previous;
      }
      const stat = await lstat(...args);
      observed.set(file, stat);
      return stat;
    });
    const result = await createPackageIntegrityReader(100).rootEntry(root);
    expect(result).toMatchObject({ kind: "directory", tree: { version: "1.0.0" } });
    expect(rounds).toBeLessThan(10);
  });
});

it("preserves earlier drift evidence when a later sweep read times out first", async () => {
  await withTestDir({ prefix: "package-integrity-sweep-order-" }, async (root) => {
    await fs.writeFile(path.join(root, "package.json"), '{"version":"1.0.0"}');
    const first = path.join(root, "a");
    const second = path.join(root, "b");
    await fs.writeFile(first, "");
    await fs.writeFile(second, "");
    const seen = new Set<string>();
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const file = String(args[0]);
      if (seen.has(file)) {
        if (file === first) {
          await setImmediate();
          await fs.writeFile(first, "changed");
        } else if (file === second) {
          throw new PackageIntegrityTimeoutError(1_000);
        }
      }
      seen.add(file);
      return lstat(...args);
    });
    await expect(createPackageIntegrityReader().rootEntry(root)).rejects.toThrow(
      "Package rollback tree changed during verification",
    );
  });
});
