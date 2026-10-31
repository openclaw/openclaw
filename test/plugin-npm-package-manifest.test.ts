import { execFile, spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { resolveNpmJsonEntries } from "../scripts/lib/npm-json-output.mts";
import {
  generatePluginNpmPackageLockWithRetry,
  resolveAugmentedPluginNpmPackageJson as resolvePackageJson,
  resolveAugmentedPluginNpmManifest as resolveManifest,
  runPluginNpmCiWithRetry,
  withAugmentedPluginNpmManifestForPackage as withManifest,
} from "../scripts/lib/plugin-npm-package-manifest.mts";
import { resolveNpmRunner } from "../scripts/npm-runner.mts";
import { hasChannelPackageState } from "../src/channels/plugins/package-state-probes.js";
import type { PluginManifest } from "../src/plugins/manifest-types.js";
import {
  closeHttpServer,
  listenLoopback,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const execFileAsync = promisify(execFile);
const registryDependencyArtifacts = new Map<string, { tarball: Buffer; integrity: string }>();
const manifestScript = fileURLToPath(
  new URL("../scripts/lib/plugin-npm-package-manifest.mjs", import.meta.url),
);
const runtimeProbeArgs = [
  "--input-type=module",
  "-e",
  'const m = await import("./dist/index.js"); console.log(JSON.stringify([m.default, m.sibling]));',
];
const channelSchema = {
  type: "object",
  required: ["channelName"],
  properties: { channelName: { type: "string" } },
};
const stateProbes = {
  configuredState: { file: "configured-state", exportName: "hasConfiguredChannelState" },
  persistedAuthState: { file: "auth-presence", exportName: "hasPersistedChannelAuth" },
};

function readText(root: string, file: string) {
  return readFileSync(join(root, file), "utf8");
}

function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    writeFileText(join(root, file), text);
  }
}

function manifestArgs(packageDir: string, command: string[]) {
  return [manifestScript, "--run", packageDir, "--", ...command];
}

function packArgs(destination: string) {
  return ["pack", "--json", "--ignore-scripts", "--pack-destination", destination];
}

function runChecked(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptions, "encoding"> = {},
) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
  return result.stdout;
}

function expectRuntimeValues(packageDir: string, sibling: number | null) {
  expect(JSON.parse(runChecked(process.execPath, runtimeProbeArgs, { cwd: packageDir }))).toEqual([
    2,
    sibling,
  ]);
}

function unexpectedPackCallback(): never {
  throw new Error("unexpected pack callback");
}

function writeGeneratedChannelMetadata(repoDir: string, pluginId = "twitch"): void {
  writeFileText(
    join(repoDir, "src/config/bundled-channel-config-metadata.generated.ts"),
    `export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = ${JSON.stringify([
      {
        pluginId,
        channelId: pluginId,
        label: "Twitch",
        description: "Twitch chat integration",
        schema: channelSchema,
      },
    ])} as const;\n`,
  );
}

function readPackageJson(packageDir: string, name = "package.json") {
  return JSON.parse(readText(packageDir, name));
}

function writeDependency(
  root: string,
  name: string,
  version: string,
  source: string | number,
  metadata: Record<string, unknown> = {},
) {
  const dir = join(root, name);
  writeJsonFile(join(dir, "package.json"), { name, version, main: "index.js", ...metadata });
  writeFileText(
    join(dir, "index.js"),
    typeof source === "number" ? `module.exports = ${source};\n` : source,
  );
  return dir;
}

function writeFileText(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, text, "utf8");
}

type NpmPackResult = { filename: string; files: Array<{ path: string }> };
const npmPackResultSchema = z.object({
  filename: z.string(),
  files: z.array(z.object({ path: z.string() })),
});

function parseNpmPackResult(stdout: string): NpmPackResult {
  return npmPackResultSchema.parse(resolveNpmJsonEntries(JSON.parse(stdout))[0]);
}

function runNpm(packageDir: string, npmArgs: string[]) {
  const invocation = resolveNpmRunner({ npmArgs });
  return runChecked(invocation.command, invocation.args, {
    ...invocation,
    cwd: packageDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listNpmPackDryRunFiles(packageDir: string): string[] {
  const result = runNpm(packageDir, ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  return parseNpmPackResult(result).files.map((entry) => entry.path);
}

function makePublishableFixture(label: string, runtime = true) {
  const repoDir = tempDirs.make(`openclaw-plugin-${label}-`);
  const packageDir = join(repoDir, "extensions/diffs");
  writeJsonFile(join(packageDir, "package.json"), {
    name: "@openclaw/diffs",
    version: "2026.5.3",
    type: "module",
    openclaw: {
      extensions: ["./index.ts"],
      setupEntry: "./setup-entry.ts",
      compat: { pluginApi: ">=2026.4.30" },
      release: { publishToNpm: true },
    },
  });
  writeJsonFile(join(packageDir, "openclaw.plugin.json"), { id: "diffs" });
  writeFiles(packageDir, {
    "README.md": "# Diffs\n",
    "SKILL.md": "# Diffs Skill\n",
    "skills/diffs/SKILL.md": "# Diffs Skill\n",
  });
  if (runtime) {
    for (const name of ["index", "setup-entry"]) {
      writeFileText(join(packageDir, "dist", `${name}.js`), "export {};\n");
    }
  }
  return { repoDir, packageDir, params: { repoRoot: repoDir, packageDir } };
}

function expectPackageFiles(files: string[], included: string[], excluded: string[] = []) {
  expect(files).toEqual(expect.arrayContaining(included));
  expect(files.filter((file) => excluded.includes(file))).toEqual([]);
}

function writeQaGatewayFixture(id: "qa-lab" | "qa-channel") {
  const repoRoot = tempDirs.make("openclaw-private-qa-manifest-");
  const packageDir = join(repoRoot, "extensions", id);
  const packageJson = {
    name: `@openclaw/${id}`,
    version: "2026.9.6",
    private: true,
    type: "module",
    files: ["**"],
    exports: { ".": "./index.ts", "./api.js": "./api.ts" },
    scripts: { prepack: "node source-only-script.js" },
    dependencies: { "parent-tooling": "7.0.0", typebox: "1.2.3", zod: "4.5.6" },
    devDependencies: { "@openclaw/plugin-sdk": "workspace:*" },
    openclaw: {
      extensions: ["./index.ts"],
      compat: { pluginApi: ">=2026.9.6" },
      build: { workerEntries: ["./src/inspection.worker.ts"] },
      ...(id === "qa-channel" ? { setupEntry: "./setup-entry.ts", channel: { id } } : {}),
    },
  };
  const manifest: PluginManifest = {
    id,
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    activation: { onStartup: false },
    ...(id === "qa-lab"
      ? {
          cliCommands: [{ name: "qa", description: "Run QA scenarios", hasSubcommands: true }],
          contracts: {
            tools: ["qa_restart_wait", "qa_restart_unsafe_probe"],
            webSearchProviders: ["qa-lab-search"],
            workerProviders: ["static-ssh"],
          },
          toolMetadata: { qa_restart_wait: { replaySafe: true } },
        }
      : { channels: [id] }),
  };
  writeJsonFile(join(packageDir, "package.json"), packageJson);
  writeJsonFile(join(packageDir, "openclaw.plugin.json"), manifest);
  for (const source of [
    "index.ts",
    "api.ts",
    "source-only-script.js",
    "src/inspection.worker.ts",
  ]) {
    writeFileText(join(packageDir, source), 'throw new Error("source-only tooling");\n');
  }
  const outputs =
    id === "qa-lab"
      ? ["gateway-entry.js"]
      : ["index.js", "setup-entry.js", "channel-plugin-api.js", "setup-plugin-api.js", "api.js"];
  for (const output of [...outputs, ".setup/lazy.mjs"]) {
    writeFileText(join(packageDir, "dist", output), "export {};\n");
  }
  if (id === "qa-channel") {
    writeGeneratedChannelMetadata(repoRoot, id);
  }
  return {
    repoRoot,
    packageDir,
    packageJson,
    manifest,
    outputs,
    profile: "qa-gateway-fixture" as const,
  };
}

function packRegistryPackages(dependencyDirs: string[], destination: string) {
  const inputs = dependencyDirs.map((dependencyDir) => {
    const sources = ["package.json", "index.js"].map((file) => readText(dependencyDir, file));
    return { dependencyDir, manifest: JSON.parse(sources[0]!), inputKey: JSON.stringify(sources) };
  });
  const missing = inputs.filter(({ inputKey }) => !registryDependencyArtifacts.has(inputKey));
  if (missing.length > 0) {
    const pack = runNpm(destination, [
      ...packArgs(destination),
      ...missing.map(({ dependencyDir }) => dependencyDir),
    ]);
    const packed = z
      .array(npmPackResultSchema.extend({ name: z.string(), version: z.string() }))
      .parse(resolveNpmJsonEntries(JSON.parse(pack)));
    expect(packed).toHaveLength(missing.length);
    for (const [index, { inputKey, manifest }] of missing.entries()) {
      expect(packed[index]).toMatchObject({ name: manifest.name, version: manifest.version });
      const tarball = readFileSync(join(destination, packed[index]!.filename));
      registryDependencyArtifacts.set(inputKey, {
        tarball,
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      });
    }
  }
  return inputs.map(({ manifest, inputKey }) => {
    const artifact = registryDependencyArtifacts.get(inputKey)!;
    return { manifest, tarball: Buffer.from(artifact.tarball), integrity: artifact.integrity };
  });
}

function writePatchedRuntimeFixture(bundling = "default") {
  const optionalDirect = bundling === "optional-direct" || bundling === "skipped-optional";
  const nested = bundling.startsWith("nested-");
  const policy = ["range-policy", "locked-optional"].includes(bundling);
  const { repoDir, packageDir, params } = makePublishableFixture("patched-artifact", false);
  const depsDir = join(packageDir, "deps");
  writeDependency(depsDir, "local-runtime-dep", "1.0.0", 1);
  const packRegistryDependency = (name: string) =>
    packRegistryPackages([join(packageDir, "deps", name)], repoDir)[0]!;
  const artifacts = [packRegistryDependency("local-runtime-dep")];
  if (bundling === "nested-other") {
    writeDependency(depsDir, "local-runtime-dep", "2.0.0", 20);
    artifacts.push(packRegistryDependency("local-runtime-dep"));
  }
  const sourceManifest = readPackageJson(packageDir);
  sourceManifest.files = ["deps/**"];
  sourceManifest.dependencies = {
    "local-runtime-dep": "1.0.0",
    "unpatched-sibling": "file:./deps/unpatched-sibling",
  };
  writeDependency(
    depsDir,
    "unpatched-sibling",
    "1.0.0",
    nested ? 'module.exports = require("local-runtime-dep");\n' : 3,
    nested
      ? {
          optionalDependencies: {
            "local-runtime-dep": bundling === "nested-other" ? "2.0.0" : "1.0.0",
          },
        }
      : {},
  );
  if (nested) {
    sourceManifest.dependencies["unpatched-sibling"] = "1.0.0";
    artifacts.push(packRegistryDependency("unpatched-sibling"));
  }
  if (policy) {
    delete sourceManifest.dependencies["unpatched-sibling"];
    sourceManifest.overrides = {
      "local-runtime-dep@^1.0.0": { ".": "^1.0.0", "unpatched-sibling": "1.0.0" },
    };
    artifacts.push(packRegistryDependency("unpatched-sibling"));
    if (bundling === "range-policy") {
      writeDependency(depsDir, "unpatched-sibling", "1.1.0", 4);
      artifacts.push(packRegistryDependency("unpatched-sibling"));
    }
  }
  if (optionalDirect) {
    sourceManifest.dependencies["local-runtime-dep"] = "0.0.0";
    sourceManifest.optionalDependencies = { "local-runtime-dep": "1.0.0" };
  }
  if (bundling === "partial") {
    sourceManifest.bundledDependencies = ["unpatched-sibling"];
  } else if (bundling === "explicit-all") {
    sourceManifest.bundledDependencies = true;
  }
  writeJsonFile(join(packageDir, "package.json"), sourceManifest);
  writeFileText(
    join(packageDir, "dist/index.js"),
    policy
      ? 'import dep from "local-runtime-dep"; export default dep.value; export const sibling = dep.child;\n'
      : 'export { default } from "local-runtime-dep";\n' +
          (nested ? 'export { default as sibling } from "unpatched-sibling";\n' : ""),
  );
  writeFileText(join(packageDir, "dist/setup-entry.js"), "export {};\n");
  const installedSource = policy
    ? 'module.exports = {value: 2, child: require("unpatched-sibling")};\n'
    : "module.exports = 2;\n";
  let installedDir = writeDependency(
    join(repoDir, "node_modules"),
    "local-runtime-dep",
    "1.0.0",
    installedSource,
    {
      ...(policy ? { optionalDependencies: { "unpatched-sibling": "^1.0.0" } } : {}),
      ...(bundling === "skipped-optional"
        ? { os: [process.platform === "win32" ? "darwin" : "win32"] }
        : {}),
      ...(bundling === "dev-engine"
        ? { devEngines: { packageManager: { name: "pnpm", version: "11.9.0", onFail: "error" } } }
        : {}),
    },
  );
  const patch = `--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1;\n+${installedSource}`;
  const patchHash = createHash("sha256").update(patch).digest("hex");
  const patchKey = "local-runtime-dep@1.0.0";
  const patchedVersion = `1.0.0(patch_hash=${patchHash})`;
  writeFileText(join(repoDir, "patches/runtime.patch"), patch);
  writeJsonFile(join(repoDir, "pnpm-workspace.yaml"), {
    patchedDependencies: { [patchKey]: "patches/runtime.patch" },
  });
  const lock = {
    lockfileVersion: "9.0",
    patchedDependencies: { [patchKey]: patchHash },
    importers: {
      "extensions/diffs": {
        [optionalDirect ? "optionalDependencies" : "dependencies"]: {
          "local-runtime-dep": { specifier: "1.0.0", version: patchedVersion },
        },
      },
    },
    packages: Object.fromEntries(
      artifacts.map(({ manifest, integrity }) => [
        `${manifest.name}@${manifest.version}`,
        { resolution: { integrity } },
      ]),
    ),
    snapshots: {
      [`local-runtime-dep@${patchedVersion}`]: {},
      ...(bundling === "nested-other" ? { "local-runtime-dep@2.0.0": {} } : {}),
      ...(nested
        ? {
            "unpatched-sibling@1.0.0": {
              optionalDependencies: {
                "local-runtime-dep": bundling === "nested-other" ? "2.0.0" : patchedVersion,
              },
            },
          }
        : {}),
    },
  };
  writeJsonFile(join(repoDir, "pnpm-lock.yaml"), lock);
  writeJsonFile(join(repoDir, "node_modules/.pnpm/lock.yaml"), lock);
  writeJsonFile(join(repoDir, "node_modules/.modules.yaml"), {
    nodeLinker: "hoisted",
    virtualStoreDir: ".pnpm",
    hoistedLocations: {
      [`local-runtime-dep@${patchedVersion}`]: ["node_modules/local-runtime-dep"],
    },
  });
  if (bundling.startsWith("isolated")) {
    const virtualStoreDirMaxLength = bundling === "isolated-short" ? 60 : 120;
    const filename = `local-runtime-dep@1.0.0_patch_hash=${patchHash}`;
    const slot =
      virtualStoreDirMaxLength === 60
        ? `${filename.slice(0, 27)}_${createHash("sha256").update(filename).digest("hex").slice(0, 32)}`
        : filename;
    const isolatedDir = join(
      repoDir,
      "node_modules",
      ".pnpm",
      slot,
      "node_modules",
      "local-runtime-dep",
    );
    mkdirSync(dirname(isolatedDir), { recursive: true });
    renameSync(installedDir, isolatedDir);
    installedDir = isolatedDir;
    mkdirSync(join(packageDir, "node_modules"), { recursive: true });
    symlinkSync(
      installedDir,
      join(packageDir, "node_modules/local-runtime-dep"),
      process.platform === "win32" ? "junction" : "dir",
    );
    writeJsonFile(join(repoDir, "node_modules/.modules.yaml"), {
      nodeLinker: "isolated",
      virtualStoreDir: ".pnpm",
      virtualStoreDirMaxLength,
    });
  }
  for (const yamlPath of [
    join(repoDir, "pnpm-workspace.yaml"),
    join(repoDir, "node_modules/.modules.yaml"),
  ]) {
    writeFileSync(yamlPath, `---\n${readFileSync(yamlPath, "utf8")}`);
  }
  return {
    repoDir,
    packageDir,
    params,
    sourceManifest,
    installedDir,
    installedSource,
    artifacts,
    lock,
  };
}

async function withRegistry<T>(
  repoDir: string,
  artifacts: ReturnType<typeof writePatchedRuntimeFixture>["artifacts"],
  run: (env: NodeJS.ProcessEnv) => Promise<T>,
) {
  const server = createServer((request, response) => {
    const versions = artifacts.filter(({ manifest }) => request.url === `/${manifest.name}`);
    const tarball = artifacts.find(
      ({ manifest }) => request.url === `/${manifest.name}-${manifest.version}.tgz`,
    );
    if (versions.length > 0) {
      respondJson(response, {
        name: versions[0]?.manifest.name,
        "dist-tags": { latest: versions.at(-1)?.manifest.version },
        versions: Object.fromEntries(
          versions.map(({ manifest, integrity }) => [
            manifest.version,
            {
              ...manifest,
              dist: {
                tarball: `${endpoint}/${manifest.name}-${manifest.version}.tgz`,
                integrity,
              },
            },
          ]),
        ),
      });
    } else if (tarball) {
      response.end(tarball.tarball);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  const endpoint = await listenLoopback(server);
  try {
    return await run({
      ...process.env,
      npm_config_registry: endpoint,
      npm_config_cache: join(repoDir, "npm-cache"),
    });
  } finally {
    await closeHttpServer(server);
  }
}

it.each(["recovered timeout", "ordinary failure", "exhausted timeout"])(
  "settles bundled dependency installs after %s",
  (scenario) => {
    const exhausted = scenario === "exhausted timeout";
    const ordinary = scenario === "ordinary failure";
    const packageDir = exhausted
      ? join(tempDirs.make("openclaw-plugin-npm-timeout-"), "extensions/whatsapp")
      : "/tmp/plugin";
    const nodeModulesPath = join(packageDir, "node_modules");
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const spawnResults = [
      { error: timeoutError, status: null },
      { error: undefined, status: 0 },
    ];
    if (exhausted) {
      mkdirSync(packageDir, { recursive: true });
    }
    const spawnOptions: SpawnSyncOptions[] = [];
    let cleanupCalls = 0;
    const result = runPluginNpmCiWithRetry(["ci"], ordinary ? {} : { cwd: packageDir }, {
      attempts: exhausted ? 3 : undefined,
      timeoutMs: ordinary || exhausted ? undefined : 1234,
      pluginDir: ordinary ? undefined : "whatsapp",
      cleanupAttempt: () => {
        if (ordinary) {
          throw new Error("cleanup should not run");
        }
        cleanupCalls += 1;
        if (exhausted) {
          rmSync(nodeModulesPath, { recursive: true, force: true });
        }
      },
      spawn: (_args, options) => {
        spawnOptions.push(options);
        if (exhausted) {
          mkdirSync(nodeModulesPath, { recursive: true });
        }
        return ordinary
          ? { error: undefined, status: 1 }
          : exhausted
            ? { error: timeoutError, status: null }
            : spawnResults.shift();
      },
    });
    expect(result.status).toBe(ordinary ? 1 : exhausted ? null : 0);
    if (ordinary) {
      expect(spawnOptions).toHaveLength(1);
    } else if (!exhausted) {
      expect(cleanupCalls).toBe(1);
      expect(spawnOptions).toEqual([
        { cwd: "/tmp/plugin", timeout: 1234 },
        { cwd: "/tmp/plugin", timeout: 1234 },
      ]);
    } else {
      expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
      expect(existsSync(nodeModulesPath)).toBe(false);
      const secondResult = runPluginNpmCiWithRetry(
        ["ci"],
        { cwd: packageDir },
        {
          cleanupAttempt: () => rmSync(nodeModulesPath, { recursive: true, force: true }),
          pluginDir: "whatsapp",
          spawn: () => {
            expect(existsSync(nodeModulesPath)).toBe(false);
            return { error: undefined, status: 0 };
          },
        },
      );
      expect(secondResult.status).toBe(0);
    }
  },
);

it.each(["recovered timeout", "ordinary failure"])(
  "settles package-lock generation after %s",
  (scenario) => {
    const ordinary = scenario === "ordinary failure";
    const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const generateOptions: Array<Record<string, unknown>> = [];
    const generate = () =>
      generatePluginNpmPackageLockWithRetry(
        "/tmp/plugin",
        { installStrategy: "shallow" },
        {
          generate: (_packageDir, options) => {
            generateOptions.push(options);
            if (ordinary) {
              throw new Error("invalid dependency");
            }
            if (generateOptions.length === 1) {
              throw timeoutError;
            }
            return '{"lockfileVersion":3}\n';
          },
          pluginDir: ordinary ? undefined : "whatsapp",
        },
      );
    if (ordinary) {
      expect(generate).toThrow("invalid dependency");
      expect(generateOptions).toHaveLength(1);
    } else {
      expect(generate()).toBe('{"lockfileVersion":3}\n');
      expect(generateOptions).toHaveLength(2);
      expect(generateOptions[0]).toMatchObject({
        env: { OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: "180000" },
        installStrategy: "shallow",
      });
      expect(generateOptions[1]).toEqual(generateOptions[0]);
    }
  },
);

it.each(["providerCatalogEntry", "capabilityCatalogEntry"] as const)(
  "overlays manifest-only channel configs and restores catalog metadata (%s)",
  (catalogField) => {
    const repoDir = tempDirs.make("openclaw-plugin-npm-package-manifest-");
    const packageDir = join(repoDir, "extensions/twitch");
    mkdirSync(packageDir, { recursive: true });
    const sourceManifest = {
      id: "twitch",
      [catalogField]: "./catalog.ts",
      channels: ["twitch"],
      controlUi: {
        entry: "dist/control-ui/fixture/index.js",
        activation: "settings-only",
        settingsViews: [{ section: "channels", panel: "detail", channelId: "twitch" }],
      },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    };
    writeJsonFile(join(packageDir, "openclaw.plugin.json"), sourceManifest);
    writeGeneratedChannelMetadata(repoDir);

    const resolved = resolveManifest({ repoRoot: repoDir, packageDir });
    expect(resolved.changed).toBe(true);
    expect(resolved.manifest).toEqual({
      ...sourceManifest,
      channelConfigs: {
        twitch: {
          description: "Twitch chat integration",
          label: "Twitch",
          schema: channelSchema,
        },
      },
    });

    const originalText = readText(packageDir, "openclaw.plugin.json");
    const result = withManifest({ repoRoot: repoDir, packageDir }, (context) => {
      const stagedManifest = readPackageJson(packageDir, "openclaw.plugin.json");
      expect(stagedManifest.channelConfigs.twitch.description).toBe("Twitch chat integration");
      expect(context.packageJsonApplied).toBe(false);
      expect(stagedManifest[catalogField]).toBe("./catalog.ts");
      return "overlay-ran";
    });
    expect(result).toBe("overlay-ran");
    expect(existsSync(join(packageDir, "package.json"))).toBe(false);
    expect(readText(packageDir, "openclaw.plugin.json")).toBe(originalText);
  },
);

it("restores both source manifests when the package overlay write fails", () => {
  const { repoDir, packageDir, params } = makePublishableFixture("npm-overlay-write-failure");
  writeGeneratedChannelMetadata(repoDir, "diffs");
  const manifestPath = join(packageDir, "openclaw.plugin.json");
  const packageJsonPath = join(packageDir, "package.json");
  writeFileSync(manifestPath, '{"id":"diffs"}\r\n');
  const originalManifest = readFileSync(manifestPath);
  const originalPackageJson = readFileSync(packageJsonPath);
  const failure = Object.assign(new Error("package overlay write failed"), { code: "EIO" });
  const write = fs.writeFileSync.bind(fs);
  let injected = false;
  let manifestAtFailure: Buffer | undefined;
  const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (!injected && file === packageJsonPath) {
      injected = true;
      manifestAtFailure = readFileSync(manifestPath);
      throw failure;
    }
    write(file, data, options);
  });
  const callback = vi.fn();
  let caught: unknown;
  try {
    withManifest({ ...params, bundleDependencies: true }, callback);
  } catch (error) {
    caught = error;
  } finally {
    writeSpy.mockRestore();
  }

  expect(injected).toBe(true);
  expect(manifestAtFailure).not.toEqual(originalManifest);
  expect(caught).toBe(failure);
  expect(callback).not.toHaveBeenCalled();
  expect(readFileSync(manifestPath)).toEqual(originalManifest);
  expect(readFileSync(packageJsonPath)).toEqual(originalPackageJson);
});

it.each(["qa-lab", "qa-channel"] as const)(
  "packs only the private %s Gateway surface and restores source metadata",
  (id) => {
    const fixture = writeQaGatewayFixture(id);
    const { packageDir, packageJson, manifest, outputs } = fixture;
    const sourcePackageText = readText(packageDir, "package.json");
    const sourceManifestText = readText(packageDir, "openclaw.plugin.json");
    withManifest(fixture, ({ packageDir: packedDir }) => {
      const packed = readPackageJson(packedDir);
      const packedManifest = readPackageJson(packedDir, "openclaw.plugin.json");
      const files = listNpmPackDryRunFiles(packedDir);
      expect(packed).toMatchObject({
        name: packageJson.name,
        version: packageJson.version,
        private: true,
      });
      expect(packed.peerDependencies.openclaw).toBe(packageJson.openclaw.compat.pluginApi);
      expect(packed.openclaw.extensions).toEqual([
        id === "qa-lab" ? "./dist/gateway-entry.js" : "./dist/index.js",
      ]);
      expect(packed.openclaw.runtimeExtensions).toEqual(packed.openclaw.extensions);
      expectPackageFiles(files, [
        ...outputs.map((output) => `dist/${output}`),
        "dist/.setup/lazy.mjs",
        "openclaw.plugin.json",
      ]);
      expect(files.some((file) => file.endsWith(".ts") || file === "source-only-script.js")).toBe(
        false,
      );
      expect([packed.exports, packed.scripts, packed.devDependencies]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(packed.openclaw.build).toBeUndefined();
      expect(packedManifest.cliCommands).toBeUndefined();
      expect(packedManifest.configSchema).toEqual(manifest.configSchema);
      expect(packedManifest.activation).toEqual(manifest.activation);
      if (id === "qa-lab") {
        expect(packed.dependencies).toEqual({});
        expect(packed.openclaw.setupEntry).toBeUndefined();
        expect(packedManifest.contracts).toEqual(manifest.contracts);
        expect(packedManifest.toolMetadata).toEqual({ qa_restart_wait: { replaySafe: true } });
      } else {
        expect(packed.dependencies).toEqual({ typebox: "1.2.3", zod: "4.5.6" });
        expect(packed.openclaw.setupEntry).toBe("./dist/setup-entry.js");
        expect(packed.openclaw.runtimeSetupEntry).toBe(packed.openclaw.setupEntry);
        expect(packedManifest.channels).toEqual(["qa-channel"]);
        expect(packedManifest.channelConfigs["qa-channel"].schema).toEqual(channelSchema);
      }
    });
    expect(readText(packageDir, "package.json")).toBe(sourcePackageText);
    expect(readText(packageDir, "openclaw.plugin.json")).toBe(sourceManifestText);

    // Metadata selection must not reintroduce parent-tooling dependencies when bundling is requested.
    const bundled = resolvePackageJson({
      ...fixture,
      bundleDependencies: true,
    });
    expect(bundled.packageJson?.bundledDependencies).toEqual(
      id === "qa-channel" ? ["typebox", "zod"] : [],
    );
  },
);

it.each([
  { id: "qa-lab", missing: "gateway-entry.js" },
  { id: "qa-channel", missing: "channel-plugin-api.js" },
] as const)("refuses private $id packaging without $missing", ({ id, missing }) => {
  const fixture = writeQaGatewayFixture(id);
  rmSync(join(fixture.packageDir, "dist", missing));
  expect(() => withManifest(fixture, unexpectedPackCallback)).toThrow(
    `package-local plugin runtime is missing for ${id}: ./dist/${missing}`,
  );
});

it.each(["missing", "another channel"])(
  "refuses a QA Channel fixture when generated schema metadata is %s",
  (scenario) => {
    const fixture = writeQaGatewayFixture("qa-channel");
    if (scenario === "missing") {
      rmSync(join(fixture.repoRoot, "src/config/bundled-channel-config-metadata.generated.ts"));
    } else {
      writeGeneratedChannelMetadata(fixture.repoRoot);
    }
    expect(() => withManifest(fixture, unexpectedPackCallback)).toThrow(
      "QA Channel fixtures require the canonical generated channel config metadata",
    );
  },
);

it("refuses publication metadata for private Gateway fixtures before applying an overlay", () => {
  const fixture = writeQaGatewayFixture("qa-lab");
  const original = readText(fixture.packageDir, "openclaw.plugin.json");
  expect(() =>
    resolveManifest({
      ...fixture,
      clawhubMetadataDir: "not-a-publication-source",
    }),
  ).toThrow("Private QA Gateway fixtures cannot use publication metadata");
  expect(readText(fixture.packageDir, "openclaw.plugin.json")).toBe(original);
});

it.for([
  ["cjs module", undefined, "cjs"],
  ["esm module", undefined, "js"],
  ["env-only", {}, "cjs"],
  ["missing exportName", { specifier: "./absent-probe" }, "cjs"],
  ["blank exportName", { specifier: "./absent-probe", exportName: " \t" }, "cjs"],
  ["missing specifier", { exportName: "hasState" }, "cjs"],
  ["blank specifier", { specifier: " \t", exportName: "hasState" }, "cjs"],
] as const)(
  "packs plugin identity and activity artwork with channel-state probes (%s)",
  ([_name, partial, extension]) => {
    const {
      repoDir,
      packageDir,
      params: fixtureParams,
    } = makePublishableFixture("npm-package-state-runtime", false);
    const sourcePackage = readPackageJson(packageDir);
    if (extension === "cjs") {
      sourcePackage.openclaw.build = { runtimeFormat: "cjs" };
    }
    sourcePackage.openclaw.channel = {
      id: "diffs",
      configuredState: {
        specifier: "./configured-state",
        exportName: "hasConfiguredChannelState",
      },
      persistedAuthState: {
        specifier: `./dist/auth-presence.${extension}`,
        exportName: "hasPersistedChannelAuth",
      },
    };
    if (partial) {
      for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
        sourcePackage.openclaw.channel[metadataKey] = {
          ...partial,
          env: { anyOf: ["SYNTHETIC_PLUGIN_TOKEN"] },
        };
      }
    }
    writeJsonFile(join(packageDir, "package.json"), sourcePackage);
    for (const { file, exportName } of Object.values(stateProbes)) {
      writeFileText(join(packageDir, `${file}.ts`), `export function ${exportName}() {}\n`);
      writeFileText(
        join(packageDir, "dist", `${file}.${extension}`),
        `${extension === "cjs" ? "exports." : "export const "}${exportName} = () => true;\n`,
      );
    }
    for (const entry of ["index", "setup-entry"]) {
      writeFileText(
        join(packageDir, "dist", `${entry}.${extension}`),
        extension === "cjs" ? "module.exports = {};\n" : "export {};\n",
      );
    }
    const activitySvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"/>';
    writeFiles(packageDir, {
      "assets/icon.png": "portable-package-icon",
      "assets/activity.svg": activitySvg,
      "assets/activity/diffs.svg": activitySvg,
      "assets/activity/notes.txt": "unpublished-notes",
      "assets/design-source.svg": "unpublished-design",
    });
    const params = { ...fixtureParams, bundleDependencies: extension === "js" };
    const expected = {
      ...sourcePackage,
      ...(params.bundleDependencies ? { bundledDependencies: [] } : {}),
      files: [
        "dist/**",
        "openclaw.plugin.json",
        "README.md",
        "SKILL.md",
        "assets/icon.png",
        "assets/activity.svg",
        "assets/activity/*.svg",
        "skills/**",
      ],
      peerDependencies: { openclaw: ">=2026.4.30" },
      peerDependenciesMeta: { openclaw: { optional: true } },
      openclaw: {
        ...sourcePackage.openclaw,
        setupEntry: `./dist/setup-entry.${extension}`,
        runtimeSetupEntry: `./dist/setup-entry.${extension}`,
        runtimeExtensions: [`./dist/index.${extension}`],
        channel: {
          id: "diffs",
          ...Object.fromEntries(
            Object.entries(stateProbes).map(([key, { file, exportName }]) => [
              key,
              partial
                ? sourcePackage.openclaw.channel[key]
                : { specifier: `./dist/${file}.${extension}`, exportName },
            ]),
          ),
        },
      },
    };
    if (extension === "js") {
      const resolved = resolvePackageJson(params);
      expect(resolved.changed).toBe(true);
      expect(resolved.packageJson).toEqual(expected);
    }
    const originalText = readText(packageDir, "package.json");
    withManifest(params, () => {
      expect(readPackageJson(packageDir)).toEqual(expected);
      const consumerDir = join(repoDir, "external-consumer");
      mkdirSync(consumerDir, { recursive: true });
      writeJsonFile(join(consumerDir, "package.json"), { private: true, type: "module" });

      const pack = runNpm(packageDir, packArgs(consumerDir));
      const packedPackage = parseNpmPackResult(pack);
      const packedFiles = packedPackage.files.map((file) => file.path);
      expectPackageFiles(
        packedFiles,
        [
          `dist/configured-state.${extension}`,
          `dist/auth-presence.${extension}`,
          "assets/icon.png",
          "assets/activity.svg",
          "assets/activity/diffs.svg",
        ],
        [
          "assets/activity/notes.txt",
          "assets/design-source.svg",
          "configured-state.ts",
          "auth-presence.ts",
        ],
      );

      runChecked("tar", ["-xzf", join(consumerDir, packedPackage.filename), "-C", consumerDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const packageRoot = join(consumerDir, "package");
      expect(readText(packageRoot, "assets/icon.png")).toBe("portable-package-icon");
      for (const activityPath of ["assets/activity.svg", "assets/activity/diffs.svg"]) {
        expect(readText(packageRoot, activityPath)).toBe(activitySvg);
      }
      if (partial) {
        const channel = readPackageJson(packageRoot).openclaw.channel;
        expect(channel).toEqual(sourcePackage.openclaw.channel);
        for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
          const probe = {
            entry: {
              channel,
              pluginId: "diffs",
              rootDir: packageRoot,
              origin: "global" as const,
            },
            metadataKey,
            cfg: {},
          };
          expect(hasChannelPackageState({ ...probe, env: {} })).toBe(false);
          expect(
            hasChannelPackageState({
              ...probe,
              env: { SYNTHETIC_PLUGIN_TOKEN: "synthetic-test-value" },
            }),
          ).toBe(true);
        }
        return;
      }
      const loaded = runChecked(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(packageRoot)};
const pkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));
for (const key of ["configuredState", "persistedAuthState"]) {
  const state = pkg.openclaw.channel[key];
  const loaded = await import(new URL(state.specifier, pathToFileURL(root + "/")));
  if (loaded[state.exportName]?.() !== true) throw new Error("packed state checker failed: " + key);
}
process.stdout.write("PACKED_PLUGIN_CHANNEL_STATE_OK\\n");
`,
        ],
        { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
      );
      expect(loaded).toBe("PACKED_PLUGIN_CHANNEL_STATE_OK\n");
    });
    expect(readText(packageDir, "package.json")).toBe(originalText);
    for (const metadataKey of ["configuredState", "persistedAuthState"] as const) {
      writeJsonFile(join(packageDir, "package.json"), {
        ...sourcePackage,
        openclaw: {
          ...sourcePackage.openclaw,
          channel: {
            id: "diffs",
            [metadataKey]: {
              env: { anyOf: ["SYNTHETIC_PLUGIN_TOKEN"] },
              specifier: "./missing-state",
              exportName: "hasState",
            },
          },
        },
      });
      expect(() => withManifest(fixtureParams, unexpectedPackCallback)).toThrow(
        `channel ${metadataKey} specifier './missing-state' has no runtime output for diffs`,
      );
    }
  },
);

it.each([
  "default destination",
  "relative destination",
  "split destination",
  "failed command",
  "ancestor optional",
])("preserves source dependencies while staging npm bundles with %s", (scenario) => {
  const { repoDir, packageDir } = makePublishableFixture("npm-package-portable-optional");
  const depsDir = join(packageDir, "deps");
  writeDependency(depsDir, "optional-platform-dep", "1.0.0", 2, {
    os: [process.platform === "win32" ? "darwin" : "win32"],
  });
  writeDependency(depsDir, "local-runtime-dep", "1.0.0", 1, {
    optionalDependencies: { "optional-platform-dep": "file:../../deps/optional-platform-dep" },
  });
  writeJsonFile(join(packageDir, "package.json"), {
    ...readPackageJson(packageDir),
    dependencies: { "local-runtime-dep": "file:./deps/local-runtime-dep" },
    devDependencies: { "@openclaw/plugin-sdk": "workspace:*" },
  });
  if (scenario === "ancestor optional") {
    writeJsonFile(join(repoDir, "node_modules/optional-platform-dep/package.json"), {
      name: "optional-platform-dep",
      version: "99.0.0",
    });
  }
  const sourceDependencyPath = join(packageDir, "node_modules/local-runtime-dep/package.json");
  const sourceVersion = '{"name":"local-runtime-dep","version":"9.0.0"}\n';
  writeFileText(sourceDependencyPath, sourceVersion);
  const sourceOnlyPath = join(packageDir, "node_modules/source-only/marker");
  writeFileText(sourceOnlyPath, "keep\n");
  const originalText = readText(packageDir, "package.json");
  const outputDir =
    scenario.includes("destination") && scenario !== "default destination"
      ? join(packageDir, "artifacts")
      : packageDir;
  mkdirSync(outputDir, { recursive: true });
  const command =
    scenario === "failed command"
      ? [process.execPath, "-e", "console.log(process.cwd()); process.exit(7);"]
      : [
          "npm",
          "pack",
          "--json",
          "--ignore-scripts",
          ...(scenario === "relative destination"
            ? ["--pack-destination=artifacts"]
            : scenario === "split destination"
              ? ["--pack-destination", "artifacts"]
              : []),
        ];
  const result = spawnSync(process.execPath, manifestArgs(packageDir, command), {
    cwd: repoDir,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1",
      ...(scenario === "ancestor optional" ? { TMPDIR: repoDir, TMP: repoDir, TEMP: repoDir } : {}),
    },
  });
  expect(result.status, result.stderr).toBe(scenario === "failed command" ? 7 : 0);
  expect(readFileSync(sourceDependencyPath, "utf8")).toBe(sourceVersion);
  expect(readFileSync(sourceOnlyPath, "utf8")).toBe("keep\n");
  expect(existsSync(join(packageDir, "package-lock.json"))).toBe(false);
  expect(readText(packageDir, "package.json")).toBe(originalText);
  if (scenario === "failed command") {
    const stagingDir = result.stdout.trim();
    expect(stagingDir).not.toBe("");
    expect(stagingDir).not.toBe(packageDir);
    expect(existsSync(stagingDir)).toBe(false);
    return;
  }
  const packed = parseNpmPackResult(result.stdout);
  const tarball = join(outputDir, packed.filename);
  expect(existsSync(tarball)).toBe(true);
  const files = packed.files.map((entry) => entry.path);
  expectPackageFiles(
    files,
    [
      "node_modules/local-runtime-dep/package.json",
      "node_modules/optional-platform-dep/package.json",
    ],
    ["package-lock.json", "npm-shrinkwrap.json"],
  );
  expect(files.some((file) => file.includes("source-only"))).toBe(false);
  const extract = (file: string) => {
    return JSON.parse(runChecked("tar", ["-xOf", tarball, `package/${file}`]));
  };
  const manifest = extract("package.json");
  expect(manifest.bundledDependencies).toEqual(["local-runtime-dep"]);
  expect(manifest.devDependencies).toBeUndefined();
  expect(extract("node_modules/local-runtime-dep/package.json").version).toBe("1.0.0");
});

it.each([
  "isolated",
  "isolated-short",
  "partial",
  "clawhub",
  "optional-direct",
  "nested-other",
  "nested-same",
  "explicit-all",
  "unchanged",
  "skipped-optional",
  "dev-engine",
  "range-policy",
  "locked-optional",
])("preserves patched dependency packaging contracts (%s)", async (bundling) => {
  const { repoDir, packageDir, params, sourceManifest, installedDir, installedSource, artifacts } =
    writePatchedRuntimeFixture(bundling);
  if (bundling === "unchanged") {
    delete sourceManifest.openclaw.setupEntry;
    writeJsonFile(join(packageDir, "package.json"), sourceManifest);
    Object.assign(
      sourceManifest,
      resolvePackageJson({ ...params, bundleDependencies: true }).packageJson,
      { bundledDependencies: ["local-runtime-dep"] },
    );
    writeJsonFile(join(packageDir, "package.json"), sourceManifest);
  }
  const consumerDir = join(repoDir, "consumer");
  mkdirSync(consumerDir);
  const originalManifest = readText(packageDir, "package.json");
  await withRegistry(repoDir, artifacts, async (registryEnv) => {
    let packResult: NpmPackResult;
    if (bundling === "clawhub") {
      const cli = join(repoDir, "clawhub");
      const cliEntry = join(repoDir, "clawhub.mjs");
      const metadata = join(consumerDir, "pack-metadata.json");
      writeFileText(
        cli,
        '#!/bin/sh\nexec "$CLAWHUB_FIXTURE_RUNTIME" "$CLAWHUB_FIXTURE_ENTRY" "$@"\n',
      );
      writeFileText(
        cliEntry,
        `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveNpmRunner } from ${JSON.stringify(new URL("../scripts/npm-runner.mts", import.meta.url).href)};
const args = process.argv.slice(2);
const source = args[args.indexOf("pack") + 1];
const destination = args[args.indexOf("--pack-destination") + 1];
const npm = resolveNpmRunner({ npmArgs: ["pack", source, "--json", "--ignore-scripts", "--pack-destination", destination] });
const stdout = execFileSync(npm.command, npm.args, { ...npm, encoding: "utf8" });
fs.writeFileSync(${JSON.stringify(metadata)}, stdout);
const output = JSON.parse(stdout);
const [packed] = Array.isArray(output) ? output : Object.values(output);
console.log(JSON.stringify({ path: path.join(destination, packed.filename) }));
`,
      );
      chmodSync(cli, 0o700);
      const env: NodeJS.ProcessEnv = {
        ...registryEnv,
        SOURCE_COMMIT: "1".repeat(40),
        SOURCE_REF: "fixture",
        OPENCLAW_PLUGIN_NPM_RUNTIME_BUILD: "0",
        OPENCLAW_CLAWHUB_CLI: cli,
        OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR: consumerDir,
        CLAWHUB_FIXTURE_RUNTIME: process.execPath,
        CLAWHUB_FIXTURE_ENTRY: cliEntry,
      };
      delete env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT;
      await execFileAsync(
        "bash",
        [
          fileURLToPath(new URL("../scripts/plugin-clawhub-publish.sh", import.meta.url)),
          "--pack",
          "extensions/diffs",
        ],
        { cwd: repoDir, encoding: "utf8", env },
      );
      packResult = parseNpmPackResult(readFileSync(metadata, "utf8"));
    } else {
      const packing = execFileAsync(
        process.execPath,
        manifestArgs(
          packageDir,
          ["range-policy", "locked-optional"].includes(bundling)
            ? [process.execPath, ...runtimeProbeArgs]
            : ["npm", ...packArgs(consumerDir)],
        ),
        {
          cwd: repoDir,
          encoding: "utf8",
          env: {
            ...registryEnv,
            OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: repoDir,
            OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES:
              bundling === "all" || bundling.startsWith("nested-") ? "1" : "0",
          },
        },
      );
      if (bundling === "skipped-optional") {
        await expect(packing).rejects.toThrow("patched runtime dependency was not installed");
        return;
      }
      const packed = await packing;
      if (["range-policy", "locked-optional"].includes(bundling)) {
        expect(JSON.parse(packed.stdout)).toEqual([2, 3]);
        return;
      }
      packResult = parseNpmPackResult(packed.stdout);
    }
    runChecked("tar", ["-xzf", join(consumerDir, packResult.filename), "-C", consumerDir]);
    const consumerPackage = join(consumerDir, "package");
    const expectedSibling =
      bundling === "nested-other" ? 20 : bundling === "nested-same" ? 2 : null;
    if (bundling.startsWith("nested-")) {
      expectRuntimeValues(consumerPackage, expectedSibling);
    }
    const npm = resolveNpmRunner({
      npmArgs: [
        "install",
        "--ignore-scripts",
        "--omit=dev",
        "--omit=peer",
        "--legacy-peer-deps",
        "--workspaces=false",
        "--no-audit",
        "--no-fund",
      ],
    });
    await execFileAsync(npm.command, npm.args, {
      cwd: consumerPackage,
      encoding: "utf8",
      ...npm,
      env: { ...registryEnv, ...npm.env },
    });
    expectRuntimeValues(consumerPackage, expectedSibling);
    const published = readPackageJson(consumerPackage);
    expect(published.dependencies).toEqual(sourceManifest.dependencies);
    expect(published.optionalDependencies).toEqual(sourceManifest.optionalDependencies);
    expect(published.bundledDependencies).toEqual(
      ["partial", "all", "explicit-all"].includes(bundling) || bundling.startsWith("nested-")
        ? ["local-runtime-dep", "unpatched-sibling"]
        : ["local-runtime-dep"],
    );
    expect(packResult.files.some(({ path }) => path.endsWith(".tgz"))).toBe(false);
    expect(readText(installedDir, "index.js")).toBe(installedSource);
    expect(readText(packageDir, "package.json")).toBe(originalManifest);
    expect(existsSync(join(packageDir, "package-lock.json"))).toBe(false);
  });
});

it("installs bundled dependencies whose shared node npm reloads under another override set", async () => {
  // Mirrors amazon-bedrock-mantle: `core` is reachable through `parent`'s scoped `types`
  // pin and through the globally pinned `format`. pnpm locks `core` in two peer contexts,
  // so no `core>types` rule exists, and npm's first lock pass and its reload of that lock
  // give the shared `core` node different override sets; `npm ci` then rejects the lock.
  const { repoDir, packageDir } = makePublishableFixture("npm-override-reload");
  const manifests: Record<string, Record<string, string>> = {
    "leaf@1.0.0": {},
    "types@1.0.0": { leaf: "1.0.0" },
    "types@1.1.0": { leaf: "1.0.0" },
    "core@1.0.0": { types: "^1.1.0" },
    "core@1.1.0": { types: "^1.1.0" },
    "env@1.0.0": { core: "1.0.0" },
    "env@1.1.0": { core: "1.1.0" },
    "creds@1.0.0": { env: "1.0.0" },
    "creds@1.1.0": { env: "1.1.0" },
    "format@1.0.0": { core: "1.0.0" },
    "parent@1.0.0": { creds: "1.0.0", format: "1.0.0", types: ">=1.0.0" },
    "modern@1.0.0": { creds: "1.1.0" },
  };
  // pnpm snapshots carry exact resolutions; registry manifests above carry npm ranges.
  const snapshots: Record<string, Record<string, string>> = {
    "leaf@1.0.0": {},
    "types@1.0.0": { leaf: "1.0.0" },
    "types@1.1.0": { leaf: "1.0.0" },
    "core@1.0.0(types@1.0.0)": { types: "1.0.0" },
    "core@1.0.0(types@1.1.0)": { types: "1.1.0" },
    "core@1.1.0": { types: "1.1.0" },
    "env@1.0.0": { core: "1.0.0(types@1.1.0)" },
    "env@1.1.0": { core: "1.1.0" },
    "creds@1.0.0": { env: "1.0.0" },
    "creds@1.1.0": { env: "1.1.0" },
    "format@1.0.0": { core: "1.0.0(types@1.1.0)" },
    "parent@1.0.0": { creds: "1.0.0", format: "1.0.0", types: "1.0.0" },
    "modern@1.0.0": { creds: "1.1.0" },
  };
  const tarballDir = join(repoDir, "tarballs");
  mkdirSync(tarballDir, { recursive: true });
  const sourceDirs = Object.entries(manifests).map(([key, dependencies]) => {
    const [name = "", version = ""] = key.split("@");
    const manifest = { name, version, main: "index.js", dependencies };
    const sourceDir = join(repoDir, "registry-src", key);
    writeJsonFile(join(sourceDir, "package.json"), manifest);
    writeFileText(join(sourceDir, "index.js"), "module.exports = true;\n");
    return sourceDir;
  });
  // npm 12 keys pack JSON by name, so pack the fixture's versions separately.
  const artifacts = ["1.0.0", "1.1.0"].flatMap((version) =>
    packRegistryPackages(
      sourceDirs.filter((dir) => dir.endsWith(`@${version}`)),
      tarballDir,
    ),
  );
  writeJsonFile(join(packageDir, "package.json"), {
    ...readPackageJson(packageDir),
    dependencies: { parent: "1.0.0", modern: "1.0.0" },
  });
  writeJsonFile(join(repoDir, "pnpm-workspace.yaml"), {});
  writeJsonFile(join(repoDir, "pnpm-lock.yaml"), {
    lockfileVersion: "9.0",
    importers: {
      "extensions/diffs": {
        dependencies: {
          parent: { specifier: "1.0.0", version: "1.0.0" },
          modern: { specifier: "1.0.0", version: "1.0.0" },
        },
      },
    },
    packages: Object.fromEntries(
      artifacts.map(({ manifest, integrity }) => [
        `${manifest.name}@${manifest.version}`,
        { resolution: { integrity } },
      ]),
    ),
    snapshots: Object.fromEntries(
      Object.entries(snapshots).map(([key, dependencies]) => [key, { dependencies }]),
    ),
  });
  await withRegistry(repoDir, artifacts, async (registryEnv) => {
    const packed = await execFileAsync(
      process.execPath,
      manifestArgs(packageDir, ["npm", ...packArgs(repoDir)]),
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...registryEnv,
          OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT: repoDir,
          OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1",
        },
      },
    );
    const files = parseNpmPackResult(packed.stdout).files.map((entry) => entry.path);
    // `parent` keeps its pinned types@1.0.0 while `core` gets the types@1.1.0 it requires.
    expect(files).toContain("node_modules/parent/node_modules/types/package.json");
    expect(files).toContain(
      "node_modules/parent/node_modules/core/node_modules/types/package.json",
    );
  });
});

it.each(["bundle opt-out", "stale install", "stale importer spec", "wrong package identity"])(
  "rejects a patched artifact when its packaging precondition fails (%s)",
  (scenario) => {
    const { repoDir, packageDir, params, sourceManifest, installedDir, lock } =
      writePatchedRuntimeFixture();
    if (scenario === "bundle opt-out") {
      sourceManifest.openclaw.release.bundleRuntimeDependencies = false;
      writeJsonFile(join(packageDir, "package.json"), sourceManifest);
    } else if (scenario === "stale install") {
      writeJsonFile(join(repoDir, "node_modules/.pnpm/lock.yaml"), {
        ...lock,
        patchedDependencies: {},
      });
    } else if (scenario === "stale importer spec") {
      lock.importers["extensions/diffs"].dependencies = {
        "local-runtime-dep": { specifier: "2.0.0", version: "2.0.0" },
      };
      writeJsonFile(join(repoDir, "pnpm-lock.yaml"), lock);
    } else {
      writeJsonFile(join(installedDir, "package.json"), {
        name: "local-runtime-dep",
        version: "2.0.0",
      });
    }
    expect(() => withManifest(params, unexpectedPackCallback)).toThrow(
      scenario === "bundle opt-out"
        ? "bundleRuntimeDependencies=false"
        : scenario === "stale install"
          ? "matching frozen pnpm install"
          : scenario === "stale importer spec"
            ? "frozen pnpm importer"
            : "identity mismatch",
    );
    expect(readText(installedDir, "index.js")).toBe("module.exports = 2;\n");
  },
);

it.each(["foreign target", "redirected slot", "unpatched slot"])(
  "rejects an isolated package link outside its frozen patched slot (%s)",
  (scenario) => {
    const { repoDir, packageDir, params, installedDir } = writePatchedRuntimeFixture("isolated");
    const target =
      scenario === "unpatched slot"
        ? join(repoDir, "node_modules/.pnpm/local-runtime-dep@1.0.0/node_modules/local-runtime-dep")
        : join(repoDir, "foreign-runtime");
    mkdirSync(dirname(target), { recursive: true });
    renameSync(installedDir, target);
    const link =
      scenario === "redirected slot"
        ? installedDir
        : join(packageDir, "node_modules/local-runtime-dep");
    rmSync(link, { force: true });
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => withManifest(params, unexpectedPackCallback)).toThrow(
      "not the frozen pnpm package",
    );
  },
);

it("does not require a patch registered for a different resolved dependency version", () => {
  const { repoDir, packageDir, params } = makePublishableFixture("unpatched-version");
  const packageJson = readPackageJson(packageDir);
  packageJson.dependencies = { "local-runtime-dep": "2.0.0" };
  writeJsonFile(join(packageDir, "package.json"), packageJson);
  writeJsonFile(join(repoDir, "pnpm-workspace.yaml"), {
    patchedDependencies: { "local-runtime-dep@1.0.0": "patches/old.patch" },
  });
  writeJsonFile(join(repoDir, "pnpm-lock.yaml"), {
    importers: {
      "extensions/diffs": {
        dependencies: { "local-runtime-dep": { specifier: "2.0.0", version: "2.0.0" } },
      },
    },
  });
  withManifest(params, (context) => {
    expect(context.packageDir).toBe(packageDir);
    expect(readPackageJson(packageDir).bundledDependencies).toBeUndefined();
  });
  expect(existsSync(join(repoDir, "node_modules"))).toBe(false);
});

it("honors plugin package opt-out for bundled runtime dependencies", () => {
  const { packageDir, params } = makePublishableFixture("npm-package-bundle-opt-out");
  writeDependency(join(packageDir, "deps"), "local-runtime-dep", "1.0.0", 1);
  const source = readPackageJson(packageDir);
  writeJsonFile(join(packageDir, "package.json"), {
    ...source,
    dependencies: { "local-runtime-dep": "file:./deps/local-runtime-dep" },
    openclaw: {
      ...source.openclaw,
      release: { publishToNpm: true, bundleRuntimeDependencies: false },
    },
  });

  const resolved = resolvePackageJson({ ...params, bundleDependencies: true });
  expect(resolved.bundleDependencies).toBe(false);
  expect(resolved.packageJson?.bundledDependencies).toBeUndefined();
  expect(resolved.packageJson?.devDependencies).toBeUndefined();
  expect(resolved.packageJson?.files).toEqual([
    "dist/**",
    "openclaw.plugin.json",
    "README.md",
    "SKILL.md",
    "skills/**",
  ]);

  const nodeModulesPath = join(packageDir, "node_modules");
  withManifest({ ...params, bundleDependencies: true }, () => {
    const staged = readPackageJson(packageDir);
    expect(staged.bundledDependencies).toBeUndefined();
    expect(existsSync(nodeModulesPath)).toBe(false);
  });
});

it.each(["missing outputs", "excluded output"])("refuses packages with %s", (scenario) => {
  const { packageDir, params } = makePublishableFixture(
    "npm-package-runtime-invalid",
    scenario !== "missing outputs",
  );
  if (scenario === "excluded output") {
    const packageJson = readPackageJson(packageDir);
    writeJsonFile(join(packageDir, "package.json"), {
      ...packageJson,
      files: ["dist/**", "!dist/setup-entry.js"],
    });
    const packedFiles = listNpmPackDryRunFiles(packageDir);
    expect(packedFiles).toContain("dist/index.js");
    expect(packedFiles).not.toContain("dist/setup-entry.js");
  }
  expect(() => resolvePackageJson(params)).toThrow(
    scenario === "missing outputs"
      ? "package-local plugin runtime is missing for diffs: ./dist/index.js, ./dist/setup-entry.js"
      : "package file rule '!dist/setup-entry.js' excludes required package-local runtime file './dist/setup-entry.js' for diffs",
  );
});
