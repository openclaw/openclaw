// Check Cli Bootstrap Imports tests cover check cli bootstrap imports script behavior.
import { createHash } from "node:crypto";
import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Parser } from "acorn";
import { build } from "tsdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayRunChunkMetadataPlugin,
  GATEWAY_RUN_CHUNK_METADATA_PATH,
  readGatewayRunChunks,
} from "../../scripts/lib/gateway-run-chunk-metadata.mts";

function snapshotAcornParserPrototype() {
  return Reflect.ownKeys(Parser.prototype).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(Parser.prototype, key),
  ]);
}
const acornPrototypeBeforeCheck = snapshotAcornParserPrototype();
const {
  checkCliBootstrapExternalImports,
  collectCliBootstrapExternalImportErrors,
  collectGatewayRunChunkBudgetErrors,
  collectNativeHookRelayBundleErrors,
  collectWorkerDeployArtifactErrors,
} = await import("../../scripts/check-cli-bootstrap-imports.mts");

const tempRoots: string[] = [];
const workerDeployArtifactNames = [
  "code-mode-node.worker.mjs",
  "file-tool-planning.worker.mjs",
  "github-exec-launcher.mjs",
  "image-processor.worker.mjs",
  "openclaw-state-read.worker.mjs",
  "service-child-group-anchor.mjs",
  "service-child-relay.mjs",
  "sqlite-store.worker.mjs",
  "worker-native-lifecycle.worker.mjs",
  "worker.mjs",
  "workspace-rsync-receiver.mjs",
];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-cli-bootstrap-imports-"));
  tempRoots.push(root);
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  return root;
}

function writeFixture(root: string, relativePath: string, source: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}

function writeGatewayRunChunk(
  root: string,
  source = "",
  { distDir = "dist", chunkName = "run-gateway.js" }: { distDir?: string; chunkName?: string } = {},
): void {
  writeFixture(root, `${distDir}/string-coerce.js`, "export const normalize = true;");
  const chunkSource = [
    'import "./string-coerce.js";',
    "const GATEWAY_AUTH_MODES = [];",
    "function addGatewayRunCommand(cmd) { return cmd; }",
    source,
  ].join("\n");
  writeFixture(root, `${distDir}/${chunkName}`, chunkSource);
  writeFixture(
    root,
    `${distDir}/cli/gateway-run-chunk.json`,
    JSON.stringify({
      version: 1,
      chunks: [
        {
          fileName: chunkName,
          sha256: createHash("sha256").update(chunkSource).digest("hex"),
        },
      ],
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITHUB_STEP_SUMMARY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-cli-bootstrap-imports", () => {
  it.each(["run-gateway.js"])(
    "allows builtins and lazy external imports with %s and a mixed-extension graph",
    (chunkName) => {
      const root = makeTempRoot();
      writeFixture(
        root,
        "dist/entry.js",
        `import fs from "node:fs";\nimport "./cli/run-main.js";\nvoid fs;\n`,
      );
      writeFixture(
        root,
        "dist/cli/run-main.js",
        `import "../light-abc123.mjs";\nexport async function run() { return import("tslog"); }\n`,
      );
      writeFixture(root, "dist/light-abc123.mjs", 'import "./string-coerce.js";\n');
      writeGatewayRunChunk(root, "", { chunkName });

      expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toStrictEqual([]);
      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toStrictEqual([]);
      expect(
        collectGatewayRunChunkBudgetErrors({ rootDir: root, legacyGatewayChunkDiscovery: true }),
      ).toStrictEqual([]);
    },
  );

  it("reports external packages in the static bootstrap graph", () => {
    const root = makeTempRoot();
    writeFixture(root, "dist/entry.js", `import "./cli/run-main.js";\n`);
    writeFixture(root, "dist/cli/run-main.js", `import "../bridge-abc123.mjs";\n`);
    writeFixture(root, "dist/bridge-abc123.mjs", `import "./heavy.js";\n`);
    writeFixture(root, "dist/heavy.js", `import { Logger } from "tslog";\nvoid Logger;\n`);
    writeGatewayRunChunk(root);

    expect(collectCliBootstrapExternalImportErrors({ rootDir: root })).toEqual([
      'CLI bootstrap static graph imports external package "tslog" from dist/heavy.js.',
    ]);
  });

  it("reports missing gateway chunks in frozen legacy targets", () => {
    const root = makeTempRoot();
    expect(
      collectGatewayRunChunkBudgetErrors({ rootDir: root, legacyGatewayChunkDiscovery: true }),
    ).toEqual([
      "CLI bootstrap import guard could not find the bundled gateway run chunk. Run pnpm build first.",
    ]);
  });

  it("rejects an empty locator without scanning for a replacement", () => {
    const root = makeTempRoot();
    writeGatewayRunChunk(root);
    writeFixture(root, "dist/cli/gateway-run-chunk.json", '{"version":1,"chunks":[]}');
    expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([
      expect.stringMatching(
        /^CLI bootstrap import guard could not read gateway run chunk metadata: .*Run pnpm build first\.$/u,
      ),
    ]);
  });

  it("requires the relay in current builds but accepts older package inventories", () => {
    const rootDir = makeTempRoot();

    expect(collectNativeHookRelayBundleErrors({ rootDir })).toEqual([]);
    expect(collectNativeHookRelayBundleErrors({ rootDir, requireNativeHookRelay: true })).toEqual([
      "CLI bootstrap import guard could not read dist/native-hook-relay/entry.js. Run pnpm build first.",
    ]);
  });

  it("accepts a bounded native hook relay graph with shared runtime chunks", () => {
    const root = makeTempRoot();
    writeFixture(
      root,
      "dist/native-hook-relay/entry.js",
      'import "../client.js";\nvoid import("../gateway-call.js");\n',
    );
    writeFixture(
      root,
      "dist/client.js",
      'import "kysely";\nimport "@openclaw/fs-safe/config";\nimport "@openclaw/fs-safe/advanced";\n',
    );

    expect(collectNativeHookRelayBundleErrors({ rootDir: root })).toEqual([]);
  });

  it("reports server owners and static imports that escape the built runtime", () => {
    const root = makeTempRoot();
    writeFixture(root, "dist/native-hook-relay/entry.js", 'import "../../outside.js";\n');
    writeFixture(root, "outside.js", "const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;\n");

    expect(collectNativeHookRelayBundleErrors({ rootDir: root })).toEqual([
      'Native hook relay static graph contains server marker "MAX_NATIVE_HOOK_RELAY_INVOCATIONS" in outside.js.',
      'Native hook relay static graph escapes the built runtime via "../../outside.js" from dist/native-hook-relay/entry.js.',
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
      checkCliBootstrapExternalImports({
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

  it("reports unexpected external packages in the native hook relay static graph", () => {
    const root = makeTempRoot();
    writeFixture(root, "dist/native-hook-relay/entry.js", 'import "commander";\n');

    expect(collectNativeHookRelayBundleErrors({ rootDir: root })).toEqual([
      'Native hook relay static graph imports unexpected package "commander" from dist/native-hook-relay/entry.js.',
    ]);
  });

  it("keeps binding searches bounded while rejecting an early name redeclared in a large module", () => {
    const root = makeTempRoot();
    const bindings = 2048;
    const source =
      Array.from(
        { length: bindings },
        (_, index) => `const bootstrap_binding_${index} = ${index};`,
      ).join("\n") + "\nlet bootstrap_binding_0;";
    writeFixture(root, "dist/worker/worker.mjs", source);
    let searchedSlots = 0;
    const indexOf = Array.prototype.indexOf;
    const observed = vi.spyOn(Array.prototype, "indexOf").mockImplementation(function (
      this: unknown[],
      value: unknown,
      fromIndex?: number,
    ) {
      if (typeof value === "string" && value.startsWith("bootstrap_binding_")) {
        searchedSlots += this.length;
      }
      return indexOf.call(this, value, fromIndex);
    });
    let errors: string[];
    try {
      errors = collectWorkerDeployArtifactErrors({
        rootDir: root,
        workerDeployEntrypoints: ["dist/worker/worker.mjs"],
      });
    } finally {
      observed.mockRestore();
    }
    expect(errors).toEqual([
      expect.stringContaining("Identifier 'bootstrap_binding_0' has already been declared"),
    ]);
    expect(searchedSlots).toBeLessThanOrEqual(bindings * 8);
    expect(snapshotAcornParserPrototype()).toEqual(acornPrototypeBeforeCheck);
  });

  it("accepts no worker artifact directory when the target has no worker contract", () => {
    const root = makeTempRoot();

    expect(
      collectWorkerDeployArtifactErrors({ rootDir: root, workerDeployEntrypoints: [] }),
    ).toEqual([]);

    writeFixture(root, "dist/worker/unexpected.mjs", "export {};\n");
    expect(
      collectWorkerDeployArtifactErrors({ rootDir: root, workerDeployEntrypoints: [] }),
    ).toEqual(["Worker deploy artifact emits unstaged runtime asset dist/worker/unexpected.mjs."]);

    rmSync(join(root, "dist/worker"), { recursive: true, force: true });
    writeFixture(root, "dist/worker", "not a directory\n");
    expect(
      collectWorkerDeployArtifactErrors({ rootDir: root, workerDeployEntrypoints: [] }),
    ).toEqual(["Worker deploy artifact directory dist/worker is unreadable."]);
  });

  it("validates every split worker chunk and rejects missing or external dependencies", () => {
    const root = makeTempRoot();
    for (const artifact of workerDeployArtifactNames) {
      writeFixture(root, `dist/worker/${artifact}`, "export {};\n");
    }
    writeFixture(root, "dist/worker/worker.mjs", 'import "./worker-chunk-start.mjs";');
    writeFixture(
      root,
      "dist/worker/worker-chunk-start.mjs",
      'export const load = () => import("./worker-chunk-lazy.mjs");',
    );
    writeFixture(root, "dist/worker/worker-chunk-lazy.mjs", 'import "node:fs";');
    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([]);

    writeFixture(root, "dist/worker/worker-chunk-lazy.mjs", 'import "unbundled";');
    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([
      'Worker deploy artifact dist/worker/worker-chunk-lazy.mjs retains runtime import "unbundled" instead of bundling it.',
    ]);
    rmSync(join(root, "dist/worker/worker-chunk-lazy.mjs"));
    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([
      'Worker deploy artifact dist/worker/worker-chunk-start.mjs retains runtime import "./worker-chunk-lazy.mjs" instead of bundling it.',
    ]);
  });

  it("rejects worker package imports and dependency manifests", () => {
    const root = makeTempRoot();
    for (const artifact of workerDeployArtifactNames) {
      writeFixture(root, `dist/worker/${artifact}`, "export {};\n");
    }
    writeFixture(
      root,
      "dist/worker/worker.mjs",
      [
        'import "left-pad";',
        'require("koffi");',
        'require("bun:ffi-extra");',
        'await import("./lazy.mjs");',
        '__require("json5");',
        '__require2("numbered");',
        '(__require)("parenthesized");',
        '__require?.("optional");',
        'const interpolated = `literal ${import("template-expression")}`;',
        String.raw`__r\u0065quire("escaped");`,
        'function nested() { require("nested"); }',
        'export * from "export-all";',
        'export { value } from "export-named";',
        'createRequire(import.meta.url)("../../package.json");',
        'moduleNamespace.createRequire(import.meta.url)("@openclaw/fs-safe/temp");',
        'import "final-external"',
      ].join("\n"),
    );
    writeFixture(root, "dist/worker/github-exec-launcher.mjs", 'import "yaml";\n');
    writeFixture(root, "dist/worker/service-child-group-anchor.mjs", 'import "signal-exit";\n');
    writeFixture(
      root,
      "dist/worker/service-child-relay.mjs",
      'await import("./service-child-group-anchor.mjs");\n',
    );
    writeFixture(root, "dist/worker/lazy.mjs", "export {};\n");
    writeFixture(
      root,
      "dist/worker/package.json",
      `${JSON.stringify({ scripts: { postinstall: "node prepare.js" } })}\n`,
    );

    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([
      'Worker deploy artifact dist/worker/github-exec-launcher.mjs retains runtime import "yaml" instead of bundling it.',
      'Worker deploy artifact dist/worker/service-child-group-anchor.mjs retains runtime import "signal-exit" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "../../package.json" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "./lazy.mjs" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "@openclaw/fs-safe/temp" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "bun:ffi-extra" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "escaped" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "export-all" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "export-named" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "final-external" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "json5" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "koffi" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "left-pad" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "nested" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "numbered" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "optional" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "parenthesized" instead of bundling it.',
      'Worker deploy artifact dist/worker/worker.mjs retains runtime import "template-expression" instead of bundling it.',
      "Worker deploy artifact emits unstaged runtime asset dist/worker/lazy.mjs.",
      "Worker deploy artifact must not contain a dependency manifest or lifecycle scripts.",
    ]);
  });

  it("rejects a missing native lifecycle worker artifact", () => {
    const root = makeTempRoot();
    const missingArtifact = "worker-native-lifecycle.worker.mjs";
    for (const artifact of workerDeployArtifactNames) {
      if (artifact !== missingArtifact) {
        writeFixture(root, `dist/worker/${artifact}`, "export {};\n");
      }
    }
    expect(collectWorkerDeployArtifactErrors({ rootDir: root })).toEqual([
      `Worker deploy artifact dist/worker/${missingArtifact} is missing. Run pnpm build first.`,
    ]);
  });
});

function createGatewayBuildFixture() {
  const root = fs.realpathSync(makeTempRoot());
  fs.mkdirSync(join(root, "src/cli/gateway-cli"), { recursive: true });
  fs.writeFileSync(join(root, "package.json"), '{"name":"locator-fixture","type":"module"}');
  // Deliberately no source-text markers: the module identity owns this locator.
  fs.writeFileSync(
    join(root, "src/cli/gateway-cli/run-command.ts"),
    "export function register() { return 42; }",
  );
  fs.writeFileSync(
    join(root, "entry.ts"),
    'export const run = () => import("./src/cli/gateway-cli/run-command.ts");',
  );
  return root;
}

// Real emission protects filename, minification and source-map behavior together.
describe("gateway run chunk metadata", () => {
  it.each([true])("binds emitted bytes with sourcemap=%s", async (sourcemap) => {
    const root = createGatewayBuildFixture();
    const plugin = createGatewayRunChunkMetadataPlugin(root);
    const { bundles } = await build({
      config: false,
      cwd: root,
      entry: { "cli/run-main": "entry.ts" },
      outDir: "dist",
      dts: false,
      outputOptions: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].mjs",
      },
      minify: true,
      sourcemap,
      plugins: [plugin],
      logLevel: "silent",
    });
    try {
      const chunks = readGatewayRunChunks(join(root, "dist"));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.filePath).toMatch(/-[A-Za-z0-9_-]+\.mjs$/u);
      expect(fs.existsSync(join(root, "dist/cli/run-main.js"))).toBe(true);
      expect(chunks[0]?.source).not.toContain("GATEWAY_AUTH_MODES");
      expect(collectGatewayRunChunkBudgetErrors({ rootDir: root })).toEqual([]);
      fs.appendFileSync(chunks[0]!.filePath, "\n// changed after emission\n");
      expect(() => readGatewayRunChunks(join(root, "dist"))).toThrow(
        "does not match its build metadata",
      );
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });

  it("permits subset builds that do not include the gateway command", async () => {
    const root = createGatewayBuildFixture();
    fs.writeFileSync(join(root, "entry.ts"), "export const unrelated = 1;");
    const { bundles } = await build({
      config: false,
      cwd: root,
      entry: "entry.ts",
      outDir: "dist",
      dts: false,
      plugins: [createGatewayRunChunkMetadataPlugin(root)],
      logLevel: "silent",
    });
    try {
      expect(fs.existsSync(join(root, "dist", GATEWAY_RUN_CHUNK_METADATA_PATH))).toBe(false);
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });
});
