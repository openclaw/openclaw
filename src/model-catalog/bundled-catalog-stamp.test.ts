import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: vi.fn(actual.createRequire) };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([undefined, "{", '{"builtAt":42}', '{"builtAt":"invalid"}', '{"builtAt":"1970-01-01"}'])(
  "retains an unavailable build stamp without repeated module probes: %s",
  (contents) => {
    const root = dirs.make("catalog-stamp-");
    const directory = path.join(root, "dist", "catalog");
    fs.mkdirSync(directory, { recursive: true });
    if (contents !== undefined) {
      fs.writeFileSync(path.join(root, "dist", "build-info.json"), contents);
    }
    const url = pathToFileURL(path.join(directory, "stamp.js")).href;
    vi.mocked(createRequire).mockClear();
    expect(bundledCatalogGeneratedAt(url)).toBeUndefined();
    expect(bundledCatalogGeneratedAt(url)).toBeUndefined();
    expect(createRequire).not.toHaveBeenCalled();
  },
);

it("keeps the loaded build's timestamp and falls through malformed candidates", () => {
  const root = dirs.make("catalog-stamp-");
  const directory = path.join(root, "dist", "catalog");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "build-info.json"), "{");
  const file = path.join(root, "build-info.json");
  fs.writeFileSync(file, '{"builtAt":"2026-11-07T00:00:00.000Z"}');
  const url = pathToFileURL(path.join(directory, "stamp.js")).href;
  expect(bundledCatalogGeneratedAt(url)).toBe(1794009600000);
  fs.unlinkSync(file);
  expect(bundledCatalogGeneratedAt(url)).toBe(1794009600000);
});
