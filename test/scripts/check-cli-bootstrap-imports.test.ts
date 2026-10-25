import { createHash } from "node:crypto";
import fs, { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Parser } from "acorn";
import { build, type InlineConfig } from "tsdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayRunChunkMetadataPlugin,
  GATEWAY_RUN_CHUNK_METADATA_PATH,
  readGatewayRunChunks,
} from "../../scripts/lib/gateway-run-chunk-metadata.mts";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../../src/shared/worker-bundle-hash.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

function snapshotAcornParserPrototype() {
  return Reflect.ownKeys(Parser.prototype).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(Parser.prototype, key),
  ]);
}
const acornPrototypeBeforeCheck = snapshotAcornParserPrototype();
const {
  checkCliBootstrapExternalImports: checkBootstrap,
  collectCliBootstrapExternalImportErrors: bootstrapErrors,
  collectGatewayRunChunkBudgetErrors: gatewayErrors,
  collectNativeHookRelayBundleErrors: relayErrors,
  collectWorkerDeployArtifactErrors: workerErrors,
} = await import("../../scripts/check-cli-bootstrap-imports.mts");

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function makeTempRoot(files: Record<string, string> = {}): string {
  const root = tempRoots.make("openclaw-cli-bootstrap-imports-");
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  for (const [file, source] of Object.entries(files)) {
    writeFixture(root, file, source);
  }
  return root;
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}

function workerFixture(files: Record<string, string> = {}) {
  const root = makeTempRoot();
  for (const artifact of WORKER_BUNDLE_ARTIFACT_PATHS) {
    writeFixture(root, `dist/worker/${artifact}`, "export {};\n");
  }
  for (const [file, source] of Object.entries(files)) {
    writeFixture(root, `dist/worker/${file}`, source);
  }
  return root;
}

function importError(file: string, specifier: string) {
  return `Worker deploy artifact dist/worker/${file}.mjs retains runtime import "${specifier}" instead of bundling it.`;
}

function expectWorkerErrors(rootDir: string, expected: string[] = [], entrypoints?: string[]) {
  expect(workerErrors({ rootDir, workerDeployEntrypoints: entrypoints })).toEqual(expected);
}

function writeGatewayRunChunk(root: string, source = ""): void {
  const chunkName = "run-gateway.js";
  const chunkSource = [
    "const GATEWAY_AUTH_MODES = [];",
    "function addGatewayRunCommand(cmd) { return cmd; }",
    source,
  ].join("\n");
  writeFixture(root, `dist/${chunkName}`, chunkSource);
  const sha256 = createHash("sha256").update(chunkSource).digest("hex");
  writeFixture(
    root,
    "dist/cli/gateway-run-chunk.json",
    JSON.stringify({ version: 1, chunks: [{ fileName: chunkName, sha256 }] }),
  );
}

beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITHUB_STEP_SUMMARY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("check-cli-bootstrap-imports", () => {
  it("allows builtins and lazy external imports with a mixed-extension graph", () => {
    const root = makeTempRoot({
      "dist/entry.js": `import fs from "node:fs";\nimport "./cli/run-main.js";\nvoid fs;\n`,
      "dist/cli/run-main.js": `import "../light-abc123.mjs";\nexport async function run() { return import("tslog"); }\n`,
      "dist/light-abc123.mjs": 'import "./string-coerce.js";\n',
      "dist/string-coerce.js": "export const normalize = true;",
    });
    writeGatewayRunChunk(root);

    expect(bootstrapErrors({ rootDir: root })).toStrictEqual([]);
    expect(gatewayErrors({ rootDir: root })).toStrictEqual([]);
    expect(gatewayErrors({ rootDir: root, legacyGatewayChunkDiscovery: true })).toStrictEqual([]);
  });

  it("reports external packages in the static bootstrap graph", () => {
    const root = makeTempRoot({
      "dist/entry.js": `import "./cli/run-main.js";\n`,
      "dist/cli/run-main.js": `import { Logger } from "tslog";\nvoid Logger;\n`,
    });
    writeGatewayRunChunk(root);

    expect(bootstrapErrors({ rootDir: root })).toEqual([
      'CLI bootstrap static graph imports external package "tslog" from dist/cli/run-main.js.',
    ]);
  });

  it("reports missing gateway chunks in frozen legacy targets", () => {
    const root = makeTempRoot();
    expect(gatewayErrors({ rootDir: root, legacyGatewayChunkDiscovery: true })).toEqual([
      "CLI bootstrap import guard could not find the bundled gateway run chunk. Run pnpm build first.",
    ]);
  });

  it("rejects an empty locator without scanning for a replacement", () => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root);
    writeFixture(root, "dist/cli/gateway-run-chunk.json", '{"version":1,"chunks":[]}');
    expect(gatewayErrors({ rootDir: root })).toEqual([
      expect.stringMatching(
        /^CLI bootstrap import guard could not read gateway run chunk metadata: .*Run pnpm build first\.$/u,
      ),
    ]);
  });

  it("requires the relay in current builds but accepts older package inventories", () => {
    const rootDir = makeTempRoot();

    expect(relayErrors({ rootDir })).toEqual([]);
    expect(relayErrors({ rootDir, requireNativeHookRelay: true })).toEqual([
      "CLI bootstrap import guard could not read dist/native-hook-relay/entry.js. Run pnpm build first.",
    ]);
  });

  it("accepts a bounded native hook relay graph with shared runtime chunks", () => {
    const root = makeTempRoot({
      "dist/native-hook-relay/entry.js":
        'import "../client.js";\nvoid import("../gateway-call.js");\n',
      "dist/client.js":
        'import "kysely";\nimport "@openclaw/fs-safe/config";\nimport "@openclaw/proc-safe/errors";\n',
    });
    expect(relayErrors({ rootDir: root })).toEqual([]);
  });

  it("reports server owners and static imports that escape the built runtime", () => {
    const root = makeTempRoot({
      "dist/native-hook-relay/entry.js": 'import "../../outside.js";\n',
      "outside.js": "const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;\n",
    });
    expect(relayErrors({ rootDir: root })).toEqual([
      'Native hook relay static graph contains server marker "MAX_NATIVE_HOOK_RELAY_INVOCATIONS" in outside.js.',
      'Native hook relay static graph escapes the built runtime via "../../outside.js" from dist/native-hook-relay/entry.js.',
    ]);
  });

  it("reports unexpected relay imports", () => {
    const root = makeTempRoot({ "dist/native-hook-relay/entry.js": 'import "commander";' });
    expect(relayErrors({ rootDir: root })).toEqual([
      'Native hook relay static graph imports unexpected package "commander" from dist/native-hook-relay/entry.js.',
    ]);
  });

  it("reports bundle budgets at the check boundary with Actions=true", () => {
    const root = makeTempRoot();
    const summaryPath = join(root, "summary.md");
    vi.stubEnv("CI", "1");
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_STEP_SUMMARY", summaryPath);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    writeGatewayRunChunk(root);
    writeFixture(root, "dist/native-hook-relay/entry.js", "export {};\n");
    const check = () =>
      checkBootstrap({
        rootDir: root,
        entrypoints: [],
        workerDeployEntrypoints: [],
        gatewayRunChunkMaxBytes: 1,
        nativeHookRelayStaticMaxBytes: 1,
      });

    expect(check).not.toThrow();
    expect(
      diagnostic.mock.calls.filter(([message]) => String(message).startsWith("::warning")),
    ).toHaveLength(2);
    expect(fs.readFileSync(summaryPath, "utf8")).toContain("Gateway run chunk budget");
    writeGatewayRunChunk(root, 'import "./server-close.js";');
    writeFixture(root, "dist/server-close.js", "export {};\n");
    expect(check).toThrow();
    expect(diagnostic.mock.calls.flat().join("\n")).toContain("static graph imports cold path");
  });

  it("rejects redeclared worker bindings without changing the Acorn prototype", () => {
    const root = makeTempRoot();
    writeFixture(
      root,
      "dist/worker/worker.mjs",
      "const bootstrap_binding_0 = 0; let bootstrap_binding_0;",
    );
    const errors = workerErrors({
      rootDir: root,
      workerDeployEntrypoints: ["dist/worker/worker.mjs"],
    });
    expect(errors).toEqual([
      expect.stringContaining("Identifier 'bootstrap_binding_0' has already been declared"),
    ]);
    expect(snapshotAcornParserPrototype()).toEqual(acornPrototypeBeforeCheck);
  });

  it("accepts no worker artifact directory when the target has no worker contract", () => {
    const root = makeTempRoot();

    expectWorkerErrors(root, [], []);

    writeFixture(root, "dist/worker/unexpected.mjs", "export {};\n");
    expectWorkerErrors(
      root,
      ["Worker deploy artifact emits unstaged runtime asset dist/worker/unexpected.mjs."],
      [],
    );

    rmSync(join(root, "dist/worker"), { recursive: true, force: true });
    writeFixture(root, "dist/worker", "not a directory\n");
    expectWorkerErrors(root, ["Worker deploy artifact directory dist/worker is unreadable."], []);
  });

  it("validates every split worker chunk and rejects missing or external dependencies", () => {
    const root = workerFixture({
      "worker.mjs": 'import "./worker-chunk-start.mjs";',
      "worker-chunk-start.mjs": 'export const load = () => import("./worker-chunk-lazy.mjs");',
      "worker-chunk-lazy.mjs": 'import "node:fs";',
    });
    expectWorkerErrors(root);

    writeFixture(root, "dist/worker/worker-chunk-lazy.mjs", 'import "unbundled";');
    expectWorkerErrors(root, [importError("worker-chunk-lazy", "unbundled")]);
    rmSync(join(root, "dist/worker/worker-chunk-lazy.mjs"));
    expectWorkerErrors(root, [importError("worker-chunk-start", "./worker-chunk-lazy.mjs")]);
  });

  it("rejects worker package imports and dependency manifests", () => {
    const root = workerFixture({
      "worker.mjs": [
        'import "left-pad";',
        'require("koffi");',
        'require("bun:ffi-extra");',
        'await import("./lazy.mjs");',
        '__require2("numbered");',
        'function nested() { require("nested"); }',
        'export * from "export-all";',
        'export { value } from "export-named";',
        'createRequire(import.meta.url)("../../package.json");',
        'moduleNamespace.createRequire(import.meta.url)("@openclaw/fs-safe/temp");',
        'import "final-external"',
      ].join("\n"),
      "github-exec-launcher.mjs": 'import "yaml";\n',
      "service-child-group-anchor.mjs": 'import "signal-exit";\n',
      "service-child-relay.mjs": 'await import("./service-child-group-anchor.mjs");\n',
      "lazy.mjs": "export {};\n",
      "package.json": '{"scripts":{"postinstall":"node prepare.js"}}\n',
    });

    expectWorkerErrors(root, [
      importError("github-exec-launcher", "yaml"),
      importError("service-child-group-anchor", "signal-exit"),
      ...`../../package.json ./lazy.mjs @openclaw/fs-safe/temp bun:ffi-extra export-all
export-named final-external koffi left-pad nested numbered`
        .split(/\s+/u)
        .map((specifier) => importError("worker", specifier)),
      "Worker deploy artifact emits unstaged runtime asset dist/worker/lazy.mjs.",
      "Worker deploy artifact must not contain a dependency manifest or lifecycle scripts.",
    ]);
  });

  it("rejects a missing native lifecycle worker artifact", () => {
    const root = workerFixture();
    const missingArtifact = "worker-native-lifecycle.worker.mjs";
    rmSync(join(root, "dist/worker", missingArtifact));
    expectWorkerErrors(root, [
      `Worker deploy artifact dist/worker/${missingArtifact} is missing. Run pnpm build first.`,
    ]);
  });
});

async function withGatewayBuild(
  entry: string,
  options: InlineConfig,
  inspect: (root: string) => void,
) {
  const root = fs.realpathSync(
    makeTempRoot({
      "package.json": '{"name":"locator-fixture","type":"module"}',
      // Deliberately no source-text markers: module identity owns this locator.
      "src/cli/gateway-cli/run-command.ts": "export function register() { return 42; }",
      "entry.ts": entry,
    }),
  );
  const { bundles } = await build({
    config: false,
    cwd: root,
    entry: "entry.ts",
    outDir: "dist",
    dts: false,
    plugins: [createGatewayRunChunkMetadataPlugin(root)],
    logLevel: "silent",
    ...options,
  });
  try {
    inspect(root);
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
}

// Real emission protects filename, minification and source-map behavior together.
describe("gateway run chunk metadata", () => {
  it("binds emitted bytes with sourcemaps", async () => {
    await withGatewayBuild(
      'export const run = () => import("./src/cli/gateway-cli/run-command.ts");',
      {
        entry: { "cli/run-main": "entry.ts" },
        outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].mjs" },
        minify: true,
        sourcemap: true,
      },
      (root) => {
        const chunks = readGatewayRunChunks(join(root, "dist"));
        expect(chunks).toHaveLength(1);
        expect(gatewayErrors({ rootDir: root })).toEqual([]);
        fs.appendFileSync(chunks[0]!.filePath, "\n// changed after emission\n");
        expect(() => readGatewayRunChunks(join(root, "dist"))).toThrow(
          "does not match its build metadata",
        );
      },
    );
  });

  it("permits subset builds that do not include the gateway command", async () => {
    await withGatewayBuild("export const unrelated = 1;", {}, (root) => {
      expect(fs.existsSync(join(root, "dist", GATEWAY_RUN_CHUNK_METADATA_PATH))).toBe(false);
    });
  });
});
