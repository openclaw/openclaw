import type { BigIntStats } from "node:fs";
import { vi } from "vitest";
import * as packageFileHasher from "./package-update-integrity-hasher.js";

export function interceptPackageFileHashes(
  intercept: (file: string, stat: BigIntStats, next: () => Promise<string>) => Promise<string> = (
    _file,
    _stat,
    next,
  ) => next(),
) {
  const create = packageFileHasher.createPackageFileHasher;
  const hash = vi.fn(intercept);
  vi.spyOn(packageFileHasher, "createPackageFileHasher").mockImplementation((...args) => {
    const hasher = create(...args);
    return {
      ...hasher,
      hash: (file, stat) => hash(file, stat, () => hasher.hash(file, stat)),
    };
  });
  return hash;
}
