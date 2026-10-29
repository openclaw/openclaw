import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  classifyRootDependencyOwnership,
  collectRootDependencyOwnershipAudit,
  collectRootDependencyOwnershipCheckErrors,
} from "../../scripts/root-dependency-ownership-audit.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function audit(files: Record<string, unknown>, scanRoots = ["extensions"]) {
  const repoRoot = tempDirs.make("openclaw-root-deps-audit-");
  for (const [relativePath, value] of Object.entries(files)) {
    const filePath = path.join(repoRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
  return collectRootDependencyOwnershipAudit({ repoRoot, scanRoots });
}

it.each([
  [["scripts", "test"], "script_or_test_only"],
  [[], "unreferenced"],
] satisfies [string[], string][])("classifies %j as %s", (sections, category) => {
  expect(classifyRootDependencyOwnership({ depName: "vendor-sdk", sections }).category).toBe(
    category,
  );
});
it("catches dependencies mirrored at root but only imported by one extension", () => {
  const records = audit({
    "package.json": { dependencies: { "vendor-sdk": "^1.0.0" } },
    "extensions/demo-channel/package.json": { dependencies: { "vendor-sdk": "^1.0.0" } },
    "extensions/demo-channel/src/setup.ts": 'const sdk = await import("vendor-sdk");\n',
  });

  expect(records).toMatchObject([{ category: "extension_only_localizable" }]);
  const errors = collectRootDependencyOwnershipCheckErrors(records);
  expect(errors).toHaveLength(1);
  for (const detail of [
    "vendor-sdk",
    "demo-channel:dependencies",
    "extensions/demo-channel/src/setup.ts",
  ]) {
    expect(errors[0]).toContain(detail);
  }
});

it("classifies root dependencies referenced through constant dynamic imports", () => {
  const records = audit(
    {
      "package.json": { dependencies: { clawpdf: "^0.2.0", "sqlite-vec": "0.1.9" } },
      "src/media/pdf-extract.ts": `
        const CLAWPDF_MODULE = "clawpdf";
        export async function loadPdf() {
          return import(CLAWPDF_MODULE);
        }
      `,
      "packages/memory-host-sdk/src/host/sqlite-vec.ts": `
        let SQLITE_VEC_MODULE_ID = "sqlite-vec";
        export async function loadSqliteVecModule() {
          return require.resolve(SQLITE_VEC_MODULE_ID);
        }
      `,
    },
    ["src", "packages"],
  );

  expect(records.map(({ depName, category }) => [depName, category])).toEqual([
    ["clawpdf", "core_runtime"],
    ["sqlite-vec", "core_runtime"],
  ]);
});

it("does not fail an explicitly root-owned extension runtime dependency", () => {
  const records = audit({
    "package.json": { dependencies: { "@homebridge/ciao": "^1.3.7" } },
    "extensions/bonjour/package.json": { dependencies: { "@homebridge/ciao": "^1.3.7" } },
    "extensions/bonjour/src/advertiser.ts":
      'const CIAO_MODULE_ID = "@homebridge/ciao";\nrequire(CIAO_MODULE_ID);\n',
  });
  expect(records).toMatchObject([{ category: "root_owned_extension_runtime" }]);
  expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
});

it("allows runtime deps for bundled plugins that are still packaged in core", () => {
  const records = audit({
    "package.json": {
      dependencies: { "vendor-sdk": "^1.0.0" },
      files: ["dist/", "!dist/extensions/externalized/**"],
    },
    "extensions/internal/package.json": { dependencies: { "vendor-sdk": "^1.0.0" } },
    "extensions/internal/openclaw.plugin.json": {},
    "extensions/internal/src/setup.ts": 'const sdk = await import("vendor-sdk");\n',
  });

  expect(records).toMatchObject([
    {
      category: "root_owned_extension_runtime",
      internalizedBundledRuntimeOwners: ["internal:dependencies"],
    },
  ]);
  expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
});
