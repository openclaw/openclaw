import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function record(
  depName: string,
  spec: string,
  sampleFile: string,
  category: string,
  declaredInExtensions: string[] = [],
  internalizedBundledRuntimeOwners: string[] = [],
) {
  return {
    category,
    declaredInExtensions,
    depName,
    fileCount: 1,
    internalizedBundledRuntimeOwners,
    sampleFiles: [sampleFile],
    sections: [sampleFile.split("/")[0]],
    spec,
  };
}

describe("classifyRootDependencyOwnership", () => {
  it.each([
    [
      ["scripts", "test"],
      "script_or_test_only",
      "consider moving from dependencies to devDependencies",
    ],
    [[], "unreferenced", "investigate removal; no direct source imports found in scanned files"],
  ] satisfies [string[], string, string][])(
    "classifies %j as %s",
    (sections, category, recommendation) => {
      expect(classifyRootDependencyOwnership({ depName: "vendor-sdk", sections })).toEqual({
        category,
        recommendation,
      });
    },
  );
});

describe("collectRootDependencyOwnershipCheckErrors", () => {
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

    expect(records).toMatchObject([
      record("clawpdf", "^0.2.0", "src/media/pdf-extract.ts", "core_runtime"),
      record(
        "sqlite-vec",
        "0.1.9",
        "packages/memory-host-sdk/src/host/sqlite-vec.ts",
        "core_runtime",
      ),
    ]);
  });

  it("does not fail explicitly root-owned internal extension runtime dependencies", () => {
    const records = audit({
      "package.json": {
        dependencies: {
          "@homebridge/ciao": "^1.3.7",
          "@opentelemetry/semantic-conventions": "1.43.0",
          "playwright-core": "1.59.1",
        },
      },
      "extensions/bonjour/package.json": { dependencies: { "@homebridge/ciao": "^1.3.7" } },
      "extensions/bonjour/src/advertiser.ts":
        'const CIAO_MODULE_ID = "@homebridge/ciao";\nrequire(CIAO_MODULE_ID);\n',
      "extensions/diagnostics-otel/src/service.ts":
        'import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";\n',
      "extensions/browser/package.json": { dependencies: { "playwright-core": "1.59.1" } },
      "extensions/browser/src/browser/playwright-core.runtime.ts":
        'const runtime = require("playwright-core");\n',
    });

    const category = "root_owned_extension_runtime";
    expect(records).toMatchObject([
      record("@homebridge/ciao", "^1.3.7", "extensions/bonjour/src/advertiser.ts", category, [
        "bonjour:dependencies",
      ]),
      record(
        "@opentelemetry/semantic-conventions",
        "1.43.0",
        "extensions/diagnostics-otel/src/service.ts",
        category,
      ),
      record(
        "playwright-core",
        "1.59.1",
        "extensions/browser/src/browser/playwright-core.runtime.ts",
        category,
        ["browser:dependencies"],
      ),
    ]);
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

    const owners = ["internal:dependencies"];
    expect(records).toMatchObject([
      record(
        "vendor-sdk",
        "^1.0.0",
        "extensions/internal/src/setup.ts",
        "root_owned_extension_runtime",
        owners,
        owners,
      ),
    ]);
    expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
  });
});
