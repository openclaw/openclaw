import fs from "node:fs";
import { expect, it } from "vitest";
import {
  recordUpdateCompatibilityRelease,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { fixtureFiles } from "./script-fixture-files.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";
import {
  previousReleaseInventory,
  writeUpdateCompatibilityBuildFixture,
} from "./update-compat-chunks.test-support.js";

const { createTempDir } = createScriptTestHarness();
const chunk = previousReleaseInventory.releases[0]!.chunks.find((entry) =>
  /-[A-Za-z0-9_-]{8}\.m?js$/.test(entry.path),
)!;
const namedExport = {
  kind: "named export",
  source: 'export { helper as NAME } from "external-package";',
};
const namespaceImport = {
  kind: "namespace import",
  source: 'import * as NAME from "external-package"; export { NAME };',
};
function candidateFixture(esm = true) {
  const f = fixtureFiles(createTempDir("update-compat-external-"));
  if (esm) {
    f.json("package.json", { type: "module" });
  }
  writeUpdateCompatibilityBuildFixture(f.root);
  const options = {
    distDir: f.file("dist"),
    sourceDir: f.root,
    inventory: previousReleaseInventory,
  };
  return { ...f, emit: () => writeUpdateCompatibilityChunks(options) };
}
async function expectLegacy(f: ReturnType<typeof candidateFixture>) {
  const legacy = await f.load(`dist/${chunk.path}`);
  for (const { exported, origin } of chunk.exports) {
    expect(legacy[exported]()).toBe(origin.symbol);
  }
}

it("keeps the published recovery predicate bound to its current command owner", async () => {
  const owner = "src/cli/update-cli/update-command-service-command.ts";
  const recovery = "src/cli/update-cli/update-command-service-recovery.ts";
  const release = previousReleaseInventory.releases.find((entry) =>
    entry.chunks.some((candidate) =>
      candidate.exports.some(
        (binding) =>
          binding.origin.module === recovery && binding.exported === "isPackageManagerUpdateMode",
      ),
    ),
  )!;
  const published = release.chunks.find((candidate) =>
    candidate.exports.some((binding) => binding.origin.module === recovery),
  )!;
  const f = fixtureFiles(createTempDir("update-compat-recovery-binding-"));
  f.json("package.json", { type: "module" });
  for (const source of [recovery, owner]) {
    f.write(source, fs.readFileSync(new URL(`../../${source}`, import.meta.url), "utf8"));
  }
  f.write(
    "dist/current-mode.mjs",
    `//#region ${owner}\nexport function isPackageManagerUpdateMode() { return "current predicate"; }\n`,
  );
  writeUpdateCompatibilityChunks({
    distDir: f.file("dist"),
    sourceDir: f.root,
    inventory: { schemaVersion: 1, releases: [{ ...release, chunks: [published] }] },
  });
  const legacy = await f.load(`dist/${published.path}`);
  expect(legacy.isPackageManagerUpdateMode()).toBe("current predicate");
});

it.each([
  'import { safePath as helper } from "@openclaw/fs-safe/path"; export { helper };',
  'import helper from "external-package"; export { helper };',
  'export { safePath as helper } from "@openclaw/fs-safe/path";',
  'export * as helper from "external-package";',
  'import * as helper from "external-package"; export { helper };',
])("keeps published updater bridges usable beside %s", async (external) => {
  const f = candidateFixture();
  f.write(
    "dist/unrelated-worker.mjs",
    `//#region ${chunk.exports[0]!.origin.module}\n${external}\n`,
  );
  f.emit();
  await expectLegacy(f);
});

it.each([
  { file: "managed-handoff-runtime.mjs", independent: true },
  { file: "package-update-activation-recovery.mjs", independent: true },
  { file: "state/openclaw-state-read-value-abcdefgh.mjs", independent: true },
  { file: "infra/sqlite-readonly-value-abcdefgh.mjs", independent: true },
  { file: "plugins/plugin-generation-preparation.worker.js", independent: true },
  { file: "plugins/plugin-preparation-value-abcdefgh.mjs", independent: true },
  { file: "process/spawn-broker/worker.js", independent: true },
  { file: "plugins/runtime-value-abcdefgh.mjs", independent: false },
  { file: "state/runtime-value-abcdefgh.mjs", independent: false },
  { file: "infra/runtime-value-abcdefgh.mjs", independent: false },
])("resolves updater ownership beside $file", async ({ file, independent }) => {
  const f = candidateFixture();
  const origin = chunk.exports[0]!.origin;
  f.write(
    `dist/${file}`,
    `//#region ${origin.module}\nfunction ${origin.symbol}() { return "independent copy"; }\nexport { ${origin.symbol} as duplicate };\n`,
  );
  if (!independent) {
    expect(f.emit).toThrow("ambiguous current exports");
    return;
  }
  f.emit();
  await expectLegacy(f);
});

it.each([namedExport, namespaceImport])(
  "refuses a required updater implementation replaced with an external $kind",
  ({ source: template }) => {
    const f = candidateFixture(false);
    const origin = chunk.exports[0]!.origin;
    f.write(origin.module, `${template.replaceAll("NAME", origin.symbol)}\n`);
    expect(f.emit).toThrow("Cannot resolve current source binding");
    expect(fs.existsSync(f.file(`dist/${chunk.path}`))).toBe(false);
  },
);

it.each([
  namedExport,
  { kind: "namespace export", source: 'export * as NAME from "external-package";' },
])("refuses to omit a published external $kind", ({ source }) => {
  const f = fixtureFiles(createTempDir("update-compat-published-external-"));
  f.json("package.json", { name: "openclaw", version: "2026.9.1" });
  f.json("dist/build-info.json", {
    version: "2026.9.1",
    buildId: "fixture",
    commit: "0".repeat(40),
  });
  f.write(
    "dist/command.mjs",
    '//#region src/cli/update-cli/update-command-service-command.ts\nexport async function restart() { return await import("./surface-abcdefgh.mjs"); }\n',
  );
  f.write(
    "dist/surface-abcdefgh.mjs",
    `//#region src/infra/value.ts\nexport const owned = 1;\n${source.replaceAll("NAME", "external")}\n`,
  );
  expect(() =>
    recordUpdateCompatibilityRelease({
      packageDir: f.root,
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    }),
  ).toThrow("Cannot trace surface-abcdefgh.mjs export external to its release source");
});

it("bridges Rolldown module labels without confusing an unrelated same-named export", async () => {
  const f = candidateFixture();
  for (const file of fs.readdirSync(f.file("dist"))) {
    if (file.startsWith("candidate-")) {
      const source = fs.readFileSync(f.file("dist/" + file), "utf8");
      f.write("dist/" + file, source.replaceAll("//#region ", "// "));
    }
  }
  const origin = chunk.exports[0]!.origin;
  f.write(
    "dist/optional-worker.mjs",
    "// src/infra/unrelated.ts\nconst example = " +
      String.fromCharCode(96) +
      "\n// " +
      origin.module +
      "\n" +
      String.fromCharCode(96) +
      ";\nfunction " +
      origin.symbol +
      '() { return "wrong owner"; }\nexport { ' +
      origin.symbol +
      " };\n",
  );
  f.emit();
  await expectLegacy(f);
});

it("records updater imports and export origins from Rolldown module labels", () => {
  const f = fixtureFiles(createTempDir("update-compat-module-labels-"));
  f.json("package.json", { name: "openclaw", version: "2026.10.1" });
  f.json("dist/build-info.json", {
    version: "2026.10.1",
    buildId: "fixture",
    commit: "0".repeat(40),
  });
  f.write(
    "dist/command.mjs",
    '// src/cli/update-cli/update-command-service-command.ts\nexport async function restart() { return (await import("./surface-abcdefgh.mjs")).owned(); }\n',
  );
  f.write(
    "dist/surface-abcdefgh.mjs",
    '// src/daemon/inspect.ts\nexport function owned() { return "owned"; }\n',
  );
  const recorded = recordUpdateCompatibilityRelease({
    packageDir: f.root,
    integrity: "sha512-Zml4dHVyZQ==",
  });
  expect(recorded.chunks).toEqual([
    {
      path: "surface-abcdefgh.mjs",
      imports: [
        {
          importer: "command.mjs",
          owner: "src/cli/update-cli/update-command-service-command.ts",
          exports: ["owned"],
        },
      ],
      exports: [
        { exported: "owned", origin: { module: "src/daemon/inspect.ts", symbol: "owned" } },
      ],
    },
  ]);
});
