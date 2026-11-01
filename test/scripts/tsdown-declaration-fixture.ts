import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import { readArtifactRecord } from "../../scripts/lib/build-artifact-cache.mts";
import { createDeclarationInputBoundary } from "../../scripts/lib/local-check-runtime.mts";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import {
  TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
  TSDOWN_UNIFIED_CONFIG_GROUP,
  TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
} from "../../scripts/lib/tsdown-config-groups.mts";
import { resolveTsdownDeclarationGeneratorInputs } from "../../scripts/lib/tsdown-declaration-generator-inputs.mts";
import { listDirectoryTreeStrictSync } from "../../src/infra/directory-walk.js";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { materializeDeclarationPackages } from "./declaration-fixture-packages.js";

const sourceRoot = process.cwd();
export const loader = pathToFileURL(path.resolve("scripts/tsx.mjs")).href;
export const declarationInputs = [
  { file: "src/contract.d.ts", name: "SourceOnly" },
  { file: "root.d.mts", name: "RootOnly" },
  {
    file: "scripts/fixture-types.d.ts",
    name: "ScriptOnly",
  },
  { file: "test/fixture-types.d.cts", name: "TestOnly" },
  { file: "src/actual.mts", name: "EmittedMts" },
  { file: "src/actual.cts", name: "EmittedCts" },
] as const;

export function createDeclarationTest() {
  const test = createCommandTest();
  test.beforeAll(() => {
    // Each writer can own multiple native compilers, including on small Windows runners.
    vi.setConfig({ maxConcurrency: Math.min(2, availableParallelism()) });
    return () => vi.resetConfig();
  });
  return test;
}

function fixtureOptions(root: string, privateQa = false, env: NodeJS.ProcessEnv = {}) {
  return {
    cwd: root,
    encoding: "utf8" as const,
    env: {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS: undefined,
      OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: undefined,
      OPENCLAW_INCLUDE_OPTIONAL_BUNDLED: undefined,
      ...env,
      OPENCLAW_BUILD_PRIVATE_QA: privateQa ? "1" : "0",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      // This synthetic graph fits a small heap; the full-repository floor does not apply.
      OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB: "1024",
      // Use the build owner's existing direct-tool path, without a fixture pnpm shim.
      OPENCLAW_BUILD_ALL_NO_PNPM: "1",
    },
  };
}

export function runFixture(
  command: CommandFixture,
  root: string,
  args: string[],
  privateQa = false,
  env: NodeJS.ProcessEnv = {},
) {
  return command.run(requireNodeTool("node"), args, fixtureOptions(root, privateQa, env));
}

export function runFixtureModule(
  command: CommandFixture,
  root: string,
  source: string,
  privateQa = false,
) {
  return runFixture(command, root, ["--input-type=module", "--eval", source], privateQa);
}

type ConfigEntries = {
  inputs: string[];
  selected: Record<string, string>;
  declarations: Record<string, string[]>;
};
// Share canonical input metadata; every case still compiles in a fresh fixture tree.
const configEntries = new Map<string, { production: ConfigEntries; qa: ConfigEntries }>();

// Real source bytes come from the import-closure owners at run time, so new relative
// imports are copied without a list edit. Owner edits still add no static import edges
// that would select these suites in product PRs (see "Declaration-fixture owner
// selection" in .agents/skills/openclaw-ci-limits).
const fixtureSources = new Map<string, Set<string>>();

function resolveFixtureSources(extraEntrypoints: readonly string[]) {
  // The generator input owner returns paths under this physical root.
  const root = fs.realpathSync(sourceRoot);
  const key = JSON.stringify([root, [...extraEntrypoints].toSorted()]);
  let sources = fixtureSources.get(key);
  if (!sources) {
    const relativeInputs = (inputs: readonly string[]) =>
      inputs
        .map((file) => path.relative(root, path.resolve(root, file)))
        .filter(
          (file) =>
            file !== ".." &&
            !file.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(file) &&
            !file.split(path.sep).includes("node_modules"),
        )
        .map((file) => file.split(path.sep).join("/"))
        .filter((file) => !["package.json", "tsconfig.json", "pnpm-lock.yaml"].includes(file));
    const generatorInputs = relativeInputs(
      ["scripts/write-plugin-sdk-entry-dts.ts", "scripts/write-unified-entry-dts.ts"].flatMap(
        (writer) => resolveTsdownDeclarationGeneratorInputs(root, writer),
      ),
    );
    sources = new Set([
      ...generatorInputs,
      ...relativeInputs(
        collectRuntimeImportClosure(root, [
          // Compiler sources are generator bytes the owner does not traverse.
          ...generatorInputs.filter((file) => /\.[cm]?[jt]s$/.test(file)),
          // runUnifiedBuild loads these modules from the fixture by URL.
          "scripts/build-all.mts",
          "scripts/lib/dist-artifact-ownership.mts",
          // The Windows job owner selects this worker by URL, without an import edge.
          "scripts/lib/managed-windows-job-launcher.mts",
          ...extraEntrypoints,
        ]),
      ),
    ]);
    fixtureSources.set(key, sources);
  }
  return sources;
}

function readConfigEntries(
  root: string,
  privateQa: boolean,
  groups: readonly string[],
): ConfigEntries {
  const result = spawnSync(
    requireNodeTool("node"),
    [
      "--input-type=module",
      "--eval",
      `
import path from "node:path";
import configs from ${JSON.stringify(pathToFileURL(path.join(root, "tsdown.config.ts")).href)};
const groups = configs.filter(config => ${JSON.stringify(groups)}.includes(config.name));
if (groups.length !== ${groups.length}) throw new Error("Missing canonical declaration groups");
const selected = Object.fromEntries(groups.flatMap(config =>
  Object.entries(config.entry).filter(([, source]) => config.dts.entry.some(entry => path.resolve(entry) === path.resolve(source)))
));
const declarations = Object.fromEntries(groups.map(config => [config.name, config.dts.entry]));
const inputs = configs.filter(config => config.name === "openclaw-unified")
  .flatMap(config => Object.values(config.entry));
process.stdout.write(JSON.stringify({ inputs, selected, declarations }));
`,
    ],
    fixtureOptions(root, privateQa),
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const entries = JSON.parse(result.stdout) as ConfigEntries;
  const relative = (source: string) => path.relative(root, path.resolve(root, source));
  return {
    inputs: entries.inputs.map(relative),
    selected: Object.fromEntries(
      Object.entries(entries.selected).map(([name, source]) => [name, relative(source)]),
    ),
    declarations: Object.fromEntries(
      Object.entries(entries.declarations).map(([name, sources]) => [name, sources.map(relative)]),
    ),
  };
}

export function createDeclarationFixture(
  command: Pick<CommandFixture, "createTempDir">,
  groups: readonly string[] = TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
  root = path.join(fs.realpathSync(command.createTempDir("openclaw-sdk-declarations-")), "Project"),
  extraEntrypoints: readonly string[] = [],
) {
  return createFixture(groups, root, extraEntrypoints);
}

export function createDeclarationFixtureWriter(root: string) {
  const boundary = createDeclarationInputBoundary(root);
  return (source: string, contents: string) => {
    const target = boundary.assert(source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  };
}

export function createFixture(
  groups: readonly string[],
  root: string,
  extraEntrypoints: readonly string[] = [],
) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, ".artifacts"));
  // Link the selected graph's real toolchain and runtime packages: each writer
  // validates the fixture's entire dependency topology before and after emit.
  for (const name of [
    ".bin",
    "@openclaw/fs-safe",
    "@openclaw/proc-safe",
    "@silvia-odwyer/photon-node",
    "highlight.js",
    "playwright-core",
    "web-tree-sitter",
    "tree-sitter-bash",
    "tsx",
    "esbuild",
    "import-meta-resolve",
    "tar",
    "yaml",
  ]) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(
      fs.realpathSync(path.join(sourceRoot, "node_modules", name)),
      target,
      "junction",
    );
  }
  materializeDeclarationPackages(root, groups === TSDOWN_UNIFIED_DTS_CONFIG_GROUPS);
  const write = createDeclarationFixtureWriter(root);
  write(
    "package.json",
    '{"name":"sdk-declaration-fixture","version":"0.0.0","private":true,"type":"module"}',
  );
  write("pnpm-workspace.yaml", "packages: []\n");
  write("pnpm-lock.yaml", fs.readFileSync(path.join(sourceRoot, "pnpm-lock.yaml"), "utf8"));
  // tsdown.config.ts passes this path to package declaration builds as compiler configuration, not an import edge.
  write(
    "tsconfig.packages.json",
    fs.readFileSync(path.join(sourceRoot, "tsconfig.packages.json"), "utf8"),
  );
  fs.mkdirSync(path.join(root, "extensions"));
  const sources = resolveFixtureSources(extraEntrypoints);
  for (const source of sources) {
    write(source, fs.readFileSync(path.join(sourceRoot, source), "utf8"));
  }
  // The unmodified config reads workspace export metadata before selecting its SDK groups.
  for (const entry of fs.readdirSync(path.join(sourceRoot, "packages"), { withFileTypes: true })) {
    const metadata = path.join(sourceRoot, "packages", entry.name, "package.json");
    if (entry.isDirectory() && fs.existsSync(metadata)) {
      write(`packages/${entry.name}/package.json`, fs.readFileSync(metadata, "utf8"));
    }
  }
  // The full config resolves these runtime inputs before selecting declaration groups.
  for (const source of [
    "src/worker/worker-deploy-browser-runtime.ts",
    "src/agents/utils/syntax-highlight.ts",
    "src/plugin-sdk/facade-runtime.ts",
    "extensions/browser/src/browser/playwright-core.runtime.ts",
    "src/infra/net/undici-dispatcher-options.ts",
    "src/infra/sealed-runtime-bootstrap.ts",
    "src/infra/command-explainer/tree-sitter-runtime.ts",
    "packages/gateway-client/src/websocket.ts",
    "src/gateway/desktop/node-stream-broker.ts",
    "src/gateway/desktop/observe-bridge.ts",
    "src/gateway/control-ui-public-session-card-render.ts",
    "src/gateway/server-runtime-state.ts",
    "src/realtime-transcription/websocket-session.ts",
  ]) {
    if (!sources.has(source)) {
      write(source, "export {};\n");
    }
  }
  if (groups === TSDOWN_UNIFIED_DTS_CONFIG_GROUPS) {
    // Exercise shared contracts across multiple plugin entries.
    for (const id of ["fixture-a", "fixture-b"]) {
      write(`extensions/${id}/openclaw.plugin.json`, JSON.stringify({ id }));
      write(
        `extensions/${id}/package.json`,
        JSON.stringify({ name: `@openclaw/${id}`, exports: { ".": "./dist/index.js" } }),
      );
      write(`extensions/${id}/index.ts`, "export {};\n");
    }
  }
  const key = groups.join(",");
  let entries = configEntries.get(key);
  if (!entries) {
    entries = {
      production: readConfigEntries(root, false, groups),
      qa: readConfigEntries(root, true, groups),
    };
    configEntries.set(key, entries);
  }
  const { production, qa } = entries;
  const selectedSources = new Set(
    Object.values(qa.selected).map((source) => source.replaceAll(path.sep, "/")),
  );
  // Rolldown resolves the complete canonical entry graph even for declaration-only groups.
  // Only unselected inputs need placeholders; selected sources receive their final contracts below.
  for (const source of new Set(qa.inputs)) {
    const relative = path.relative(root, path.resolve(root, source)).replaceAll(path.sep, "/");
    // Installed entrypoints belong to the linked dependency, never the placeholder graph.
    if (relative.split("/").includes("node_modules")) {
      continue;
    }
    if (!sources.has(relative) && !selectedSources.has(relative)) {
      write(source, "export {};\n");
    }
  }
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        types: [],
        paths: {
          "@openclaw/llm-core": ["./src/shared.ts"],
          "@openclaw/llm-core/contract": ["./contracts/current.ts"],
        },
      },
      include: ["src/**/*.ts"],
    }),
  );
  write(
    "src/shared.ts",
    '/** Nominal contract documentation. */\nexport class Shared { private brand = "canonical"; }',
  );
  const writeDeclarations = (value: string) => {
    for (const { file, name } of declarationInputs) {
      write(file, `export interface ${name} { value: "${value}"; }`);
    }
    write(`contracts/${value}.ts`, `export interface TransitiveAlias { value: "${value}"; }`);
    write("contracts/current.ts", `export type { TransitiveAlias } from "./${value}.js";`);
  };
  writeDeclarations("before");
  write("test/unrelated.test.ts", "export const test = 1;\n");
  write("ui/unrelated.ts", "export const view = 1;\n");
  write(".github/workflows/unrelated.yml", "name: unrelated before\n");
  // Cache tests edit these bytes; creating the file instead would change the namespace.
  write("scripts/lib/ci-node-test-plan.mts", "export {};\n");
  write("src/schema.d.ts", 'declare module "*.sql" { const text: string; export default text; }');
  write("src/schema.sql", "CREATE TABLE fixture (value TEXT NOT NULL);");
  for (const source of selectedSources) {
    if (sources.has(source)) {
      continue;
    }
    if (groups === TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS && source === "src/plugin-sdk/core.ts") {
      write(
        source,
        [
          '/// <reference path="../schema.d.ts" />',
          'import schema from "../schema.sql";',
          'export { Shared } from "@openclaw/llm-core";',
          "export function getSchema(): string { return schema; }",
        ].join("\n"),
      );
      continue;
    }
    write(
      source,
      [
        'export { Shared } from "@openclaw/llm-core";',
        'export type { TransitiveAlias } from "@openclaw/llm-core/contract";',
        ...declarationInputs.map(({ file, name }) => {
          const relative = path.relative(path.dirname(source), file).replaceAll(path.sep, "/");
          const specifier = (relative.startsWith(".") ? relative : `./${relative}`).replace(
            /(?:\.d)?\.([cm]?)ts$/u,
            ".$1js",
          );
          return `export type { ${name} } from "${specifier}";`;
        }),
      ].join("\n"),
    );
  }
  return {
    root,
    write,
    writeDeclarations,
    production: Object.keys(production.selected),
    qa: Object.keys(qa.selected),
    declarations: production.declarations,
  };
}

export function runWriter(
  command: CommandFixture,
  root: string,
  privateQa = false,
  env: NodeJS.ProcessEnv = {},
) {
  return runFixture(
    command,
    root,
    [path.join(root, "scripts/write-plugin-sdk-entry-dts.ts")],
    privateQa,
    env,
  );
}

export function runUnifiedBuild(command: CommandFixture, root: string, runtimeConfig: string) {
  return runFixtureModule(
    command,
    root,
    `
import { resolveBuildAllSteps, runBuildAllSteps } from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/build-all.mts")).href)};
import { withDistArtifactOwnership } from ${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/dist-artifact-ownership.mts")).href)};
await withDistArtifactOwnership(process.cwd(), async () => {
  const steps = resolveBuildAllSteps("full").filter(step =>
    ["tsdown", "write-unified-entry-dts"].includes(step.label)).map(step =>
      step.label === "tsdown"
        // Keep runtime compilation on the caller-selected fixture graph.
        ? { ...step, args: [...step.args, "--config", ${JSON.stringify(runtimeConfig)}, "--filter", ${JSON.stringify(TSDOWN_UNIFIED_CONFIG_GROUP)}] }
        : step);
  const result = await runBuildAllSteps("full", { steps });
  process.exitCode = result.exitCode;
});
`,
  );
}

export function runUnifiedWriter(
  command: CommandFixture,
  root: string,
  env: NodeJS.ProcessEnv = {},
) {
  return runFixture(
    command,
    root,
    [path.join(root, "scripts/write-unified-entry-dts.ts")],
    false,
    env,
  );
}

export function treeHashes(root: string) {
  return Object.fromEntries(
    listDirectoryTreeStrictSync(root)
      .map((walkEntry) => walkEntry.relativePath)
      .filter((name) => fs.statSync(path.join(root, name)).isFile())
      .toSorted()
      .map((name) => [
        name.replaceAll(path.sep, "/"),
        createHash("sha256")
          .update(fs.readFileSync(path.join(root, name)))
          .digest("hex"),
      ]),
  );
}

export function declarationCacheRecords(root: string) {
  const cache = path.join(root, ".artifacts/build-all-cache");
  return fs.readdirSync(cache).map((name) => {
    const record = readArtifactRecord(path.join(cache, name, "stamp.json"));
    expect(record, name).toBeDefined();
    return record!;
  });
}

export function expectOutputs(root: string, entries: readonly string[], files: string[]) {
  const sdk = path.join(root, "dist/plugin-sdk");
  expect(
    fs
      .readdirSync(sdk)
      .filter((name) => name.endsWith(".d.ts"))
      .toSorted(),
  ).toEqual(entries.map((entry) => `${entry.slice("plugin-sdk/".length)}.d.ts`).toSorted());
  for (const entry of entries) {
    expect(fs.statSync(path.join(root, `dist/${entry}.d.ts`)).size, entry).toBeGreaterThan(0);
  }
  const text = files
    .filter((name) => /\.d\.[cm]?ts$/u.test(name))
    .map((name) => fs.readFileSync(path.join(root, "dist", name), "utf8"))
    .join("\n");
  expect(text).toContain("Nominal contract documentation.");
  expect(text).not.toContain("schema.sql");
  expect(text).not.toContain("CREATE TABLE fixture");
  expect(text).not.toContain(root);
  expect(text).not.toContain("plugin-sdk-staging-");
  expect(files.some((name) => name.endsWith(".sql"))).toBe(false);
}

export function expectStagingClean(root: string) {
  expect(
    fs
      .readdirSync(path.join(root, ".artifacts"))
      .filter(
        (name) => name.startsWith("plugin-sdk-staging-") || name.startsWith("native-declarations-"),
      ),
  ).toEqual([]);
  expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/owner.json"))).toBe(false);
}
