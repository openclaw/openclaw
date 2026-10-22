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
  recommendation: string,
  declaredInExtensions: string[] = [],
  internalizedBundledRuntimeOwners: string[] = [],
) {
  return {
    category,
    declaredInExtensions,
    depName,
    fileCount: 1,
    internalizedBundledRuntimeOwners,
    recommendation,
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
    [
      ["extensions", "test"],
      "extension_only_localizable",
      "remove from root package.json and rely on owning extension manifests plus doctor --fix",
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

    expect(collectRootDependencyOwnershipCheckErrors(records)).toEqual([
      "root dependency 'vendor-sdk' is extension-owned (remove from root package.json and rely on owning extension manifests plus doctor --fix); extension declarations: demo-channel:dependencies; sample imports: extensions/demo-channel/src/setup.ts",
    ]);
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

    expect(records).toEqual([
      record("clawpdf", "^0.2.0", "src/media/pdf-extract.ts", "core_runtime", "keep at root"),
      record(
        "sqlite-vec",
        "0.1.9",
        "packages/memory-host-sdk/src/host/sqlite-vec.ts",
        "core_runtime",
        "keep at root",
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

    expect(records).toEqual([
      record(
        "@homebridge/ciao",
        "^1.3.7",
        "extensions/bonjour/src/advertiser.ts",
        "root_owned_extension_runtime",
        "keep at root; the Bonjour runtime is shipped with packaged startup surfaces even though the bundled plugin also declares it",
        ["bonjour:dependencies"],
      ),
      record(
        "@opentelemetry/semantic-conventions",
        "1.43.0",
        "extensions/diagnostics-otel/src/service.ts",
        "root_owned_extension_runtime",
        "keep at root; the bundled Mistral runtime in @openclaw/ai imports these constants even though only the diagnostics plugin imports them directly in repository source",
      ),
      record(
        "playwright-core",
        "1.59.1",
        "extensions/browser/src/browser/playwright-core.runtime.ts",
        "root_owned_extension_runtime",
        "keep at root; the internal browser runtime is shipped with core even though downloadable browser-adjacent plugins also declare it",
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

    expect(records).toEqual([
      record(
        "vendor-sdk",
        "^1.0.0",
        "extensions/internal/src/setup.ts",
        "root_owned_extension_runtime",
        "keep at root while bundled plugin runtime dependencies are internalized; owners: internal:dependencies",
        ["internal:dependencies"],
        ["internal:dependencies"],
      ),
    ]);
    expect(collectRootDependencyOwnershipCheckErrors(records)).toStrictEqual([]);
  });
});
