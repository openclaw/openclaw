import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

const ALLOWED_BUNDLED_CAPABILITY_METADATA_CONSUMERS = new Set([
  "src/plugins/bundled-capability-metadata.test.ts",
  "src/plugins/contracts/boundary-invariants.test.ts",
]);

const ALLOWED_EXTENSION_PATH_STRING_TESTS = new Set([
  "src/channels/plugins/bundled.shape-guard.test.ts",
  "src/plugins/contracts/bundled-extension-config-api-guardrails.test.ts",
  "src/scripts/test-projects.test.ts",
]);

describe("plugin contract boundary invariants", () => {
  it("keeps bundled-capability-metadata confined to contract/test inventory", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/**/*.ts", {
      cwd: REPO_ROOT,
      nodir: true,
    });
    const offenders = files.filter((file) => {
      if (ALLOWED_BUNDLED_CAPABILITY_METADATA_CONSUMERS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the bundled contract inventory out of non-test runtime code", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/**/*.ts", {
      cwd: REPO_ROOT,
      nodir: true,
      ignore: ["src/**/*.test.ts"],
    });
    const offenders = files.filter((file) => {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps core tests off bundled extension deep imports", async () => {
    const { globSync } = await import("glob");
    const files = globSync("src/**/*.test.ts", {
      cwd: REPO_ROOT,
      nodir: true,
    });
    const offenders = files.filter((file) => {
      if (ALLOWED_EXTENSION_PATH_STRING_TESTS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return (
        /from\s+["'][^"']*extensions\/.+(?:api|runtime-api|test-api)\.js["']/u.test(source) ||
        /vi\.(?:mock|doMock)\(\s*["'][^"']*extensions\/.+["']/u.test(source) ||
        /importActual<[^>]*>\(\s*["'][^"']*extensions\/.+["']/u.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });
});
