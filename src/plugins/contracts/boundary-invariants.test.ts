import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

const ALLOWED_BUNDLED_CAPABILITY_METADATA_CONSUMERS = new Set([
  "src/media-generation/provider-capabilities.contract.test.ts",
  "src/plugins/bundled-capability-metadata.test.ts",
  "src/plugins/contracts/boundary-invariants.test.ts",
]);

const ALLOWED_EXTENSION_PATH_STRING_TESTS = new Set([
  "src/plugin-sdk/browser-maintenance.test.ts",
  "src/channels/plugins/bundled.shape-guard.test.ts",
  "src/cli/capability-cli.test.ts",
  "src/commands/doctor-legacy-config.migrations.test.ts",
  "src/plugins/contracts/bundled-extension-config-api-guardrails.test.ts",
  "src/scripts/test-projects.test.ts",
]);

const ALLOWED_CONTRACT_BUNDLED_PATH_HELPERS = new Set([
  "src/plugins/contracts/boundary-invariants.test.ts",
  "src/plugins/contracts/plugin-sdk-index.bundle.test.ts",
  "src/plugins/contracts/plugin-sdk-runtime-api-guardrails.test.ts",
]);

const ALLOWED_CHANNEL_BUNDLED_METADATA_CONSUMERS = new Set([
  "src/channels/plugins/bundled.ts",
  "src/channels/plugins/contracts/runtime-artifacts.ts",
  "src/channels/plugins/session-conversation.bundled-fallback.test.ts",
]);

type FileFilter = {
  excludeTests?: boolean;
  testOnly?: boolean;
};

function listTsFiles(rootRelativePath: string, filter: FileFilter = {}): string[] {
  const root = resolve(REPO_ROOT, rootRelativePath);
  const files: string[] = [];

  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        continue;
      }
      const repoRelativePath = relative(REPO_ROOT, fullPath).split(sep).join("/");
      if (filter.excludeTests && repoRelativePath.endsWith(".test.ts")) {
        continue;
      }
      if (filter.testOnly && !repoRelativePath.endsWith(".test.ts")) {
        continue;
      }
      files.push(repoRelativePath);
    }
  }

  walk(root);
  return files.toSorted();
}

describe("plugin contract boundary invariants", () => {
  it("keeps bundled-capability-metadata confined to contract/test inventory", () => {
    const files = listTsFiles("src");
    const offenders = files.filter((file) => {
      if (ALLOWED_BUNDLED_CAPABILITY_METADATA_CONSUMERS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the bundled contract inventory out of non-test runtime code", () => {
    const files = listTsFiles("src", { excludeTests: true });
    const offenders = files.filter((file) => {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("contracts/inventory/bundled-capability-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps core tests off bundled extension deep imports", () => {
    const files = listTsFiles("src", { testOnly: true });
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

  it("keeps plugin contract tests off bundled path helpers unless the test is explicitly about paths", () => {
    const files = listTsFiles("src/plugins/contracts", { testOnly: true });
    const offenders = files.filter((file) => {
      if (ALLOWED_CONTRACT_BUNDLED_PATH_HELPERS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("test/helpers/bundled-plugin-paths");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps channel production code off bundled-plugin-metadata helpers", () => {
    const files = listTsFiles("src/channels", { excludeTests: true });
    const offenders = files.filter((file) => {
      if (ALLOWED_CHANNEL_BUNDLED_METADATA_CONSUMERS.has(file)) {
        return false;
      }
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return source.includes("plugins/bundled-plugin-metadata");
    });
    expect(offenders).toEqual([]);
  });

  it("keeps contract loaders off hand-built bundled extension paths", () => {
    const files = [
      ...listTsFiles("src/plugins", { excludeTests: true }),
      ...listTsFiles("src/channels", { excludeTests: true }),
    ].toSorted();
    const offenders = files.filter((file) => {
      const source = readFileSync(resolve(REPO_ROOT, file), "utf8");
      return /extensions\/\$\{|\.\.\/\.\.\/\.\.\/\.\.\/extensions\//u.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
