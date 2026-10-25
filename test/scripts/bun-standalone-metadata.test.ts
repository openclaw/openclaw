import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isEmbeddedStandaloneModule } from "../../cli-invocation.mjs";
import { parseFrontmatterBlockResult } from "../../packages/markdown-core/src/frontmatter.js";
import { rewriteStandaloneImports } from "../../scripts/lib/bun-standalone-imports.mjs";
import { createStandaloneMetadataAdapter } from "../../scripts/lib/bun-standalone-metadata.mjs";
import { createStandaloneNativeAdapter } from "../../scripts/lib/bun-standalone-native.mjs";
import { createStandaloneSourceParser } from "../../scripts/lib/bun-standalone-source-parser.mjs";
import { resolveHookManifestMetadata } from "../../src/hooks/frontmatter.js";
import {
  describeRootFileOpenFailure,
  openRootFileSync,
  readFileDescriptorBoundedSync,
} from "../../src/infra/boundary-file-read.js";
import { readRootJsonObjectSync } from "../../src/infra/json-files.js";
import {
  createRuntimeProcessEntrypoints,
  pluginRuntimeProcessManifest,
} from "../../src/infra/runtime-process-manifest.ts";
import { resolveRuntimeWorkerArgv } from "../../src/infra/runtime-worker-url.ts";
import { tryProcessCwd } from "../../src/infra/safe-cwd.js";
import {
  resolveImmutableInstallIdentity,
  resolvePluginCandidateInstallOwner,
} from "../../src/plugins/candidate-install-owner.js";
import { PluginDashboardDeclarationError } from "../../src/plugins/dashboard-capabilities.js";
import { shouldRejectHardlinkedPluginFiles } from "../../src/plugins/hardlink-policy.js";
import { PUBLIC_SURFACE_SOURCE_EXTENSIONS } from "../../src/plugins/package-entrypoints.js";
import {
  isPathInside,
  openPluginRootFileSync,
  safeRealpathSync,
} from "../../src/plugins/path-safety.js";
import { createPluginCacheSdk, getPluginSdkHostFacts } from "../../src/plugins/plugin-cache-sdk.js";

const temporaryRoots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  temporaryRoots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

const parse = createStandaloneSourceParser();

function ownerSource(relative: string, functionName?: string, typed = false): string {
  const original = fs.readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
  const source = typed ? original : stripTypeScriptTypes(original);
  const ast = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  return ast.body
    .flatMap((statement) => {
      const declaration =
        statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
      if (
        ((declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "TSTypeAliasDeclaration") &&
          (!functionName || declaration.id?.name === functionName)) ||
        (functionName &&
          declaration?.type === "VariableDeclaration" &&
          declaration.declarations.some(
            (entry) => entry.id.type === "Identifier" && entry.id.name === functionName,
          ))
      ) {
        if (declaration.start == null || declaration.end == null) {
          throw new Error("Parsed owner declaration has no source offsets");
        }
        return [source.slice(declaration.start, declaration.end)];
      }
      return [];
    })
    .join("\n");
}

function fixture({
  withPublicSurfaces = false,
  withPublicSurface = false,
  minifiedMetadata = false,
  retainSourceFiles = false,
  retainImageFiles = false,
  secretEntrypointOnDisk = false,
  typedMetadata = false,
} = {}) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-image-metadata-"));
  temporaryRoots.push(runtime);
  const plugin = path.join(runtime, "dist/extensions/example");
  const sdk = path.join(runtime, "dist/plugin-sdk");
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(sdk, { recursive: true });
  const entry = path.join(plugin, "index.js");
  const doctor = path.join(plugin, "doctor-contract-api.js");
  const sdkEntry = path.join(sdk, "example.js");
  const launcher = path.join(runtime, "openclaw.mjs");
  const bridge = path.join(runtime, "dist/mcp/plugin-tools-serve.js");
  const hookDir = path.join(runtime, "dist/bundled/image-hook");
  const hookHandler = path.join(hookDir, "handler.js");
  const secretEntrypoint = path.join(plugin, "handlers/resolver.js");
  const undeclaredEntrypoint = path.join(plugin, "handlers/other.js");
  const mxc = path.join(runtime, "dist/extensions/mxc");
  const mxcLauncher = path.join(mxc, "mxc-spawn-launcher.mjs");
  const vault = path.join(runtime, "dist/extensions/vault");
  const vaultResolver = path.join(vault, "vault-secret-ref-resolver.js");
  const sqliteWorker = path.join(runtime, "dist/state/openclaw-state.worker.js");
  const mainEntry = path.join(runtime, "dist/entry.js");
  const providerPolicy = path.join(plugin, "provider-policy-api.js");
  const doctorBytes = Buffer.from("export const contract = { version: 1 };\n");
  fs.writeFileSync(entry, "export default {};\n");
  fs.writeFileSync(doctor, doctorBytes);
  fs.writeFileSync(sdkEntry, "export {};\n");
  fs.writeFileSync(path.join(plugin, "package.json"), "{}");
  fs.writeFileSync(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      secretProviderIntegrations: {
        example: { command: "${node}", args: ["./handlers/resolver.js"] },
      },
    }),
  );
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookDir, "HOOK.md"),
    '---\nname: image-hook\ndescription: Embedded handler\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n',
  );
  fs.mkdirSync(path.dirname(secretEntrypoint));
  fs.mkdirSync(mxc, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  for (const dir of [mxc, vault]) {
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "{}");
  }
  const imageEntries = [
    entry,
    doctor,
    sdkEntry,
    launcher,
    bridge,
    hookHandler,
    ...(secretEntrypointOnDisk ? [] : [secretEntrypoint]),
    mxcLauncher,
    vaultResolver,
    sqliteWorker,
    mainEntry,
    path.join(runtime, "node_modules/fixture/index.js"),
  ];
  const sourceFiles: string[] = [];
  if (withPublicSurface) {
    imageEntries.push(providerPolicy);
  }
  if (withPublicSurfaces) {
    const sourcePlugin = path.join(runtime, "extensions/example");
    fs.mkdirSync(sourcePlugin, { recursive: true });
    fs.writeFileSync(path.join(sourcePlugin, "package.json"), '{"name":"@openclaw/example"}');
    for (const filename of [
      "api.ts",
      "runtime-api.ts",
      "diagnostics-api.mts",
      "test-api.ts",
      "internal.ts",
    ]) {
      const sourceFile = path.join(sourcePlugin, filename);
      sourceFiles.push(sourceFile);
      fs.writeFileSync(sourceFile, "export {};\n");
      imageEntries.push(path.join(plugin, `${path.parse(filename).name}.js`));
    }
    imageEntries.push(path.join(plugin, "unlisted-api.js"));
  }
  for (const file of imageEntries.slice(5)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export default () => {};\n");
  }
  if (secretEntrypointOnDisk) {
    fs.writeFileSync(secretEntrypoint, "export default () => {};\n");
  }
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(launcher, "export {};\n");
  fs.writeFileSync(bridge, "export {};\n");
  const embeddedPaths = Object.fromEntries(
    imageEntries.map((file) => [
      path.relative(runtime, file).split(path.sep).join("/"),
      `image:${file}`,
    ]),
  );
  const adapter = createStandaloneMetadataAdapter({
    runtimeRoot: runtime,
    embeddedPaths,
    parse,
  });
  if (!retainImageFiles) {
    imageEntries.forEach((file) => fs.unlinkSync(file));
  }
  if (!retainSourceFiles) {
    sourceFiles.forEach((file) => fs.unlinkSync(file));
  }
  const imageFiles = new Set(imageEntries);
  const observedFs = new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        !["readFileSync", "statSync", "lstatSync", "existsSync", "realpathSync"].includes(
          String(property),
        )
      ) {
        return value;
      }
      return (...args: unknown[]) => {
        if (typeof args[0] === "string" && imageFiles.has(args[0])) {
          throw new Error(`Unexpected disk access: ${String(property)} ${args[0]}`);
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  const roots = new Map<
    string,
    {
      paths: Map<string, unknown>;
      checkedEntries: Map<string, unknown>;
      files: Map<string, unknown>;
    }
  >();
  const getRoot = (name: string) => {
    let root = roots.get(name);
    if (!root) {
      root = { paths: new Map(), checkedEntries: new Map(), files: new Map() };
      roots.set(name, root);
    }
    return root;
  };
  const safeOpen = vi.fn(() => ({ ok: false, reason: "path" }));
  const rootOpen = vi.fn(openRootFileSync);
  const sdkCache = createPluginCacheSdk();
  const context = vm.createContext({
    path,
    URL,
    Buffer,
    crypto,
    fs: observedFs,
    root: runtime,
    __openclawStandaloneRootUrl: pathToFileURL(`${runtime}${path.sep}`).href,
    process,
    DEFAULT_PLUGIN_METADATA_MAX_BYTES: 16 * 1024 * 1024,
    require: createRequire(import.meta.url),
    getPluginCacheRoot: getRoot,
    getPluginCache: () => ({ sdk: sdkCache }),
    getPluginSdkHostFacts,
    isRecord,
    PUBLIC_SURFACE_SOURCE_EXTENSIONS,
    openClawRootFsSync: observedFs,
    fileURLToPath,
    pathToFileURL,
    bindPluginCacheRoot: (name: string) => getRoot(name),
    openPluginRootFileSync: safeOpen,
    openRootFileSync: rootOpen,
    bundledRootFileOpen: rootOpen,
    readFileDescriptorBoundedSync,
    parseFrontmatterBlockResult,
    resolveHookManifestMetadata,
    HOOK_METADATA_MAX_BYTES: 1024 * 1024,
    isPathInside: (root: string, target: string) => {
      const relative = path.relative(root, target);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    },
    materializeErrorStack: () => {},
    FsSafeError: class extends Error {},
    safeFileSignature: (name: string) => observedFs.statSync(name),
    safeHashFile: (filePath: string) =>
      crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
    normalizeLowercaseStringOrEmpty,
    pluginRuntimeProcessManifest,
    runtimeProcessEntrypoints: createRuntimeProcessEntrypoints(import.meta.url),
    resolveRuntimeWorkerArgv,
  });
  vm.runInContext(adapter.bootstrap.replace("import.meta.require(", "require("), context);
  for (const [file, name] of [
    ["cli-invocation.mjs", "isEmbeddedStandaloneModule"],
    ["src/infra/runtime-process-package-url.ts", "resolvePackageRuntimeProcessEntrypointUrl"],
    ["src/infra/runtime-process-dependency-url.ts", "resolvePluginRuntimeProcessAssetUrl"],
    ["src/plugins/plugin-cache-files.ts", undefined],
    ["src/plugins/plugin-registry-snapshot.ts", "fileContentMatches"],
    ["src/infra/openclaw-root.ts", "candidateDirsFromArgv1"],
    ["src/infra/openclaw-root.ts", "dedupeCandidates"],
    ["extensions/acpx/src/config.ts", undefined],
    ["src/hooks/discovery.ts", "loadHookFromDir"],
    ["src/hooks/discovery.ts", "readRootFileUtf8"],
    ["src/hooks/discovery.ts", "withOpenedRootFileSync"],
    ["src/secrets/provider-integrations.ts", "resolvePluginRelativePath"],
    ["src/secrets/provider-integrations.ts", "isSecurePosixPathStat"],
    ["src/secrets/provider-integrations.ts", "resolveNodeEntrypointArg"],
    ["extensions/mxc/src/plugin-root.ts", undefined],
    ["extensions/vault/src/cli.ts", "resolveResolverScriptPath"],
  ] as const) {
    const source = ownerSource(file, name, typedMetadata);
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/owner.js"),
      contents:
        minifiedMetadata && file === "src/plugins/plugin-cache-files.ts"
          ? transformSync(source, {
              minifyIdentifiers: true,
              minifySyntax: true,
              minifyWhitespace: true,
            }).code
          : source,
    });
    const executable = transformed.contents.replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(entry).href),
    );
    vm.runInContext(typedMetadata ? stripTypeScriptTypes(executable) : executable, context);
  }
  return {
    runtime,
    plugin,
    sdk,
    entry,
    doctor,
    sdkEntry,
    doctorBytes,
    launcher,
    bridge,
    hookDir,
    hookHandler,
    secretEntrypoint,
    undeclaredEntrypoint,
    mxc,
    mxcLauncher,
    vault,
    vaultResolver,
    sqliteWorker,
    mainEntry,
    providerPolicy,
    safeOpen,
    rootOpen,
    context,
    adapter,
    embeddedPaths,
  };
}

describe("standalone image metadata", () => {
  it("distinguishes embedded modules from directories and later disk additions", () => {
    const { runtime, entry, context } = fixture();
    vi.stubGlobal(
      "__openclawStandaloneIsEmbeddedModule",
      // eslint-disable-next-line no-underscore-dangle -- Compiler bootstrap contract.
      context.__openclawStandaloneIsEmbeddedModule,
    );
    expect(isEmbeddedStandaloneModule(pathToFileURL(entry).href)).toBe(true);
    expect(isEmbeddedStandaloneModule(path.dirname(entry))).toBe(false);
    const fetched = path.join(runtime, "later.js");
    fs.writeFileSync(fetched, "export const value = 42;");
    expect(isEmbeddedStandaloneModule(fetched)).toBe(false);
  });
  it("retains legacy metadata without admitting chunks and resolves typed image aliases", () => {
    const { runtime, plugin, doctor, doctorBytes, sdkEntry, embeddedPaths, context } = fixture({
      retainImageFiles: true,
    });
    const legacy = "dist/legacy-only.js";
    const dependency = "dist/plugin-sdk/transitive.js";
    const source = ".typed-source/context/src/typed.ts";
    const alias = ".typed-source/context/src/typed.js";
    const typedBytes = "export const value: number = 7;\n";
    const legacyEntry = "dist/extensions/example/index.js";
    const legacySize = fs.statSync(path.join(runtime, legacyEntry)).size;
    fs.writeFileSync(path.join(runtime, legacy), "export const legacy = true;\n");
    fs.writeFileSync(path.join(runtime, dependency), "export const dependency = true;\n");
    fs.writeFileSync(sdkEntry, 'import "./transitive.js"; import "./schema.json";\n');
    fs.mkdirSync(path.dirname(path.join(runtime, source)), { recursive: true });
    fs.writeFileSync(path.join(runtime, source), typedBytes);
    const image = {
      ...embeddedPaths,
      [source]: "image:typed",
      [alias]: "image:typed",
      [legacyEntry]: "image:typed",
    };
    const adapter = createStandaloneMetadataAdapter({
      runtimeRoot: runtime,
      embeddedPaths: image,
      metadataEntries: [...Object.keys(embeddedPaths), legacy, dependency],
      parse,
    });
    vm.runInContext(adapter.bootstrap.replace("import.meta.require(", "require("), context);
    expect(
      context["__openclawStandaloneImageRead"]({
        rootDir: plugin,
        relativePath: "doctor-contract-api.js",
      }).contents,
    ).toEqual(doctorBytes);
    expect(context["__openclawStandaloneDoctorHash"](doctor)).toBe(
      crypto.createHash("sha256").update(doctorBytes).digest("hex"),
    );
    for (const entry of [source, alias]) {
      expect(context["__openclawStandaloneImageStat"](path.join(runtime, entry)).size).toBe(
        Buffer.byteLength(typedBytes),
      );
    }
    expect(context["__openclawStandaloneImageStat"](path.join(runtime, legacyEntry)).size).toBe(
      legacySize,
    );
    for (const entry of [legacy, dependency]) {
      expect(context["__openclawStandaloneImageStat"](path.join(runtime, entry))).toBeUndefined();
      expect(
        context["__openclawStandaloneModuleOpen"]({
          rootPath: runtime,
          absolutePath: path.join(runtime, entry),
        }),
      ).toBeUndefined();
    }
  });

  it.each(
    [false, true].flatMap((physical) => [false, true].map((minified) => ({ physical, minified }))),
  )(
    "keeps persisted image metadata fresh (physical=$physical, minified=$minified)",
    ({ physical, minified }) => {
      const { runtime, plugin, entry, providerPolicy, context, adapter } = fixture({
        withPublicSurface: true,
        retainImageFiles: physical,
      });
      Object.assign(context, { fs, safeRealpathSync, isPathInside });
      for (const [file, name] of [
        ["src/plugins/plugin-registry-comparison.ts", "isContainedPluginPath"],
        ["src/plugins/installed-plugin-index-manifest.ts", "isOptionalPluginManifestFile"],
        ["src/plugins/installed-plugin-index-manifest.ts", "hasOptionalMissingPluginManifestFile"],
      ] as const) {
        vm.runInContext(
          adapter.transform({
            filename: path.join(runtime, "dist/snapshot-helper.js"),
            contents: ownerSource(file, name),
          }).contents,
          context,
        );
      }
      const manifestPath = path.join(plugin, "openclaw.plugin.json");
      const record = {
        rootDir: plugin,
        enabled: true,
        source: entry,
        setupSource: providerPolicy,
        manifestPath,
        manifestHash: crypto
          .createHash("sha256")
          .update(fs.readFileSync(manifestPath))
          .digest("hex"),
      };
      const source = ownerSource(
        "src/plugins/plugin-registry-snapshot.ts",
        "hasStalePersistedPluginMetadataFiles",
      );
      vm.runInContext(source, context);
      expect(context.hasStalePersistedPluginMetadataFiles({ plugins: [record] })).toBe(!physical);
      const transformed = adapter.transform({
        filename: path.join(runtime, "dist/snapshot-owner.js"),
        contents: minified
          ? transformSync(source, {
              minifyIdentifiers: true,
              minifySyntax: true,
              minifyWhitespace: true,
            }).code
          : source,
      });
      vm.runInContext(transformed.contents, context);
      const exists = vi.spyOn(fs, "existsSync");
      try {
        expect(context.hasStalePersistedPluginMetadataFiles({ plugins: [record] })).toBe(false);
        expect(exists).not.toHaveBeenCalledWith(entry);
        expect(exists).not.toHaveBeenCalledWith(providerPolicy);
        fs.writeFileSync(manifestPath, "{}");
        expect(context.hasStalePersistedPluginMetadataFiles({ plugins: [record] })).toBe(true);

        const externalRoot = path.join(runtime, "external-plugin");
        fs.mkdirSync(externalRoot);
        const externalSource = path.join(externalRoot, "index.js");
        const externalManifest = path.join(externalRoot, "openclaw.plugin.json");
        fs.writeFileSync(externalSource, "export {};\n");
        fs.writeFileSync(externalManifest, "{}");
        const externalRecord = {
          ...record,
          rootDir: externalRoot,
          source: externalSource,
          setupSource: undefined,
          manifestPath: externalManifest,
          manifestHash: crypto.createHash("sha256").update("{}").digest("hex"),
        };
        expect(context.hasStalePersistedPluginMetadataFiles({ plugins: [externalRecord] })).toBe(
          false,
        );
        fs.unlinkSync(externalSource);
        expect(context.hasStalePersistedPluginMetadataFiles({ plugins: [externalRecord] })).toBe(
          true,
        );
      } finally {
        exists.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "omits development source probes without filesystem access (physical=%s)",
    (physical) => {
      const { runtime, plugin, context } = fixture();
      const omitted = [
        path.join(runtime, "scripts"),
        path.join(runtime, "src/plugin-sdk/example.ts"),
        path.join(runtime, "src/plugins/runtime/index.ts"),
        path.join(runtime, "packages/ai/src/index.ts"),
        path.join(runtime, "extensions/example/api.ts"),
        path.join(runtime, "extensions/example/api.mjs"),
      ];
      if (physical) {
        for (const filename of omitted) {
          if (filename === omitted[0]) {
            fs.mkdirSync(filename);
          } else {
            fs.mkdirSync(path.dirname(filename), { recursive: true });
            fs.writeFileSync(filename, "export {};\n");
          }
        }
      }
      const unknown = path.join(runtime, "unknown-file");
      const asset = path.join(plugin, "assets/browser.js");
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-external-source-"));
      temporaryRoots.push(externalRoot);
      const external = path.join(externalRoot, "packages/ai/src/index.ts");
      for (const filename of [unknown, asset, external]) {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, "fixture");
      }
      const probes = [
        vi.spyOn(fs, "existsSync"),
        vi.spyOn(fs, "statSync"),
        vi.spyOn(fs, "lstatSync"),
        vi.spyOn(fs, "realpathSync"),
      ];
      try {
        for (const filename of omitted) {
          expect(context.pluginCacheExistsSync(filename)).toBe(false);
        }
        expect(probes.every((probe) => probe.mock.calls.length === 0)).toBe(true);
        for (const filename of [unknown, asset, external, path.join(plugin, "package.json")]) {
          expect(context.pluginCacheExistsSync(filename)).toBe(true);
          expect(probes[0]).toHaveBeenCalledWith(filename);
        }
        Object.assign(context, {
          INTERNAL_CORE_PACKAGE_ALIASES: [
            { packageName: "@openclaw/ai", packageDir: "ai", subpaths: [["", "index.ts"]] },
          ],
          INTERNAL_CORE_EXPORTED_PACKAGE_DIRS: [],
          normalizePathForBoundary: (filename: string) =>
            context.pluginCacheRealpathSync(filename) ?? path.resolve(filename),
        });
        vm.runInContext(
          ownerSource(
            "src/plugins/plugin-sdk-native-resolver.ts",
            "listInternalCorePackageNativeAliases",
          ),
          context,
        );
        expect(context.listInternalCorePackageNativeAliases(runtime)).toEqual([]);
        expect(context.listInternalCorePackageNativeAliases(externalRoot)).toMatchObject([
          { request: "@openclaw/ai", target: external },
        ]);
        for (const filename of omitted) {
          expect(
            probes.every((probe) => !probe.mock.calls.some((args) => args[0] === filename)),
          ).toBe(true);
        }
      } finally {
        probes.forEach((probe) => probe.mockRestore());
      }
    },
  );

  it.each(["source", "minified", "shadowed-template"])(
    "checks flattened dependency manifests through the status owner (%s)",
    (format) => {
      const { runtime, plugin, context, adapter } = fixture();
      const dependencyName = "@example/shared";
      const writeManifest = (directory: string, value: unknown) => {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(value));
      };
      const dependency = (version: string) => {
        const directory = path.join(
          runtime,
          "node_modules/.pnpm",
          `@example+shared@${version}`,
          "node_modules/@example/shared",
        );
        writeManifest(directory, { name: dependencyName, version });
        fs.writeFileSync(path.join(directory, "index.js"), "export {};\n");
        return directory;
      };
      const dependencies = [dependency("1.0.0"), dependency("2.0.0")] as const;
      const sibling = path.join(runtime, "dist/extensions/sibling");
      for (const [directory, name, dependencyDirectory] of [
        [runtime, "openclaw", dependencies[0]],
        [plugin, "example", dependencies[1]],
        [sibling, "sibling", dependencies[0]],
      ] as const) {
        writeManifest(directory, {
          name,
          version: "1.0.0",
          dependencies: { [dependencyName]: "*" },
        });
        fs.mkdirSync(path.join(directory, "node_modules/@example"), { recursive: true });
        fs.symlinkSync(dependencyDirectory, path.join(directory, "node_modules", dependencyName));
      }
      const native = createStandaloneNativeAdapter({ runtimeRoot: runtime, parse });
      context.root = fs.realpathSync(runtime);
      for (const directory of dependencies) {
        native.transform({ filename: path.join(directory, "index.js"), contents: "export {};\n" });
      }
      const finalized = native.finalize();
      vm.runInContext(
        native.bootstrap
          .replace(/^import[^\n]+\n/, "")
          .replace(
            finalized.bootstrapReplacement.search,
            finalized.bootstrapReplacement.replacement,
          ),
        context,
      );
      for (const file of finalized.files) {
        const destination = path.join(runtime, file.destination);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(runtime, file.source), destination);
      }
      for (const directory of [runtime, plugin, sibling]) {
        fs.rmSync(path.join(directory, "node_modules"), { recursive: true });
      }
      Object.assign(context, {
        readRootJsonObjectSync,
        safeRealpathSync,
        isPathInside,
        MAX_DEPENDENCY_MANIFEST_BYTES: 1024 * 1024,
      });
      let source = [
        "dependencyPathSegments",
        "findDependencyPackageDir",
        "buildDependencyEntries",
        "buildPluginDependencyStatus",
      ]
        .map((name) => ownerSource("src/plugins/status-dependencies-core.ts", name))
        .join("\n");
      if (format === "shadowed-template") {
        source = source
          .replaceAll("params", "candidate")
          .replaceAll('"node_modules"', "`node_modules`");
      }
      const status = (rootDir: string, dependencyRootDir = runtime) =>
        context.buildPluginDependencyStatus({
          rootDir,
          dependencyRootDir,
          dependencies: { [dependencyName]: "*" },
        });
      vm.runInContext(source, context);
      expect(status(plugin).requiredInstalled).toBe(false);
      const transformed = adapter.transform({
        filename: path.join(runtime, "dist/dependency-owner.js"),
        contents:
          format === "minified"
            ? transformSync(source, {
                minifyIdentifiers: true,
                minifySyntax: true,
                minifyWhitespace: true,
              }).code
            : source,
      });
      vm.runInContext(transformed.contents, context);
      const flatRoot = path.join(
        fs.realpathSync(runtime),
        "native/@example+shared@1.0.0/@example/shared",
      );
      const flatPlugin = path.join(
        fs.realpathSync(runtime),
        "native/@example+shared@2.0.0/@example/shared",
      );
      for (const [directory, expected, version] of [
        [runtime, flatRoot, "1.0.0"],
        [plugin, flatPlugin, "2.0.0"],
        [sibling, flatRoot, "1.0.0"],
      ] as const) {
        const actual = status(directory);
        expect(actual.requiredInstalled).toBe(true);
        expect(actual.dependencies[0].resolvedPath).toBe(expected);
        expect(
          JSON.parse(fs.readFileSync(path.join(expected, "package.json"), "utf8")).version,
        ).toBe(version);
      }
      expect(status(plugin, plugin).requiredInstalled).toBe(false);
      const manifest = path.join(flatPlugin, "package.json");
      fs.writeFileSync(manifest, "{");
      expect(status(plugin).requiredInstalled).toBe(false);
      fs.unlinkSync(manifest);
      expect(status(plugin).dependencies[0].resolvedPath).toBe(flatRoot);
      fs.unlinkSync(path.join(flatRoot, "package.json"));
      expect(status(plugin).requiredInstalled).toBe(false);
      writeManifest(flatRoot, { name: dependencyName, version: "1.0.0" });
      fs.mkdirSync(manifest);
      expect(status(plugin).requiredInstalled).toBe(false);
      fs.rmdirSync(manifest);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-external-dependency-"));
      temporaryRoots.push(outside);
      writeManifest(outside, { name: dependencyName, version: "external" });
      fs.symlinkSync(path.join(outside, "package.json"), manifest);
      expect(status(plugin).requiredInstalled).toBe(false);

      const externalPlugin = path.join(outside, "plugin");
      const externalDependency = path.join(externalPlugin, "node_modules", dependencyName);
      writeManifest(externalDependency, { name: dependencyName, version: "3.0.0" });
      const externalStatus = status(externalPlugin, outside);
      expect(externalStatus.requiredInstalled).toBe(true);
      expect(externalStatus.dependencies[0].resolvedPath).toBe(fs.realpathSync(externalDependency));
      fs.writeFileSync(path.join(externalDependency, "package.json"), "{");
      expect(status(externalPlugin, outside).requiredInstalled).toBe(false);
    },
  );

  it.each(
    (["channel", "setup"] as const).flatMap((owner) =>
      (["source", "minified", "imported"] as const).map((format) => ({ owner, format })),
    ),
  )("admits modules through the $owner loader ($format)", ({ owner, format }) => {
    const { runtime, plugin, entry, context, adapter } = fixture();
    const errors: string[] = [];
    const channels: unknown[] = [];
    const sources = new Map<string, { variants: Map<string, unknown> }>();
    const open = vi.fn(openPluginRootFileSync);
    const moduleExport = {
      kind: "bundled-channel-entry",
      id: "example",
      loadChannelPlugin: () => ({ id: "example", meta: { runtime: true } }),
    };
    const require = createRequire(import.meta.url);
    const loadModule = vi.fn((filename: string) =>
      filename === entry ? moduleExport : require(filename),
    );
    Object.assign(context, {
      openPluginRootFileSync: open,
      secureOpen: open,
      fsAlias: context.fs,
      describeRootFileOpenFailure,
      getPluginCacheSource: (filename: string) => {
        let source = sources.get(filename);
        if (!source) {
          source = { variants: new Map() };
          sources.set(filename, source);
        }
        return source;
      },
      getCachedPluginModuleLoader: () => loadModule,
      resolvePluginRuntimeExecutionArtifact: (artifact: unknown) => artifact,
      getPluginInstance: () => undefined,
      withProfile: (_params: unknown, _label: string, callback: () => unknown) => callback(),
    });
    for (const [file, name] of [
      ["src/plugins/native-module-require.ts", "isJavaScriptModulePath"],
      ["src/plugins/native-module-require.ts", "PLUGIN_SOURCE_MODULE_EXTENSIONS"],
      ["src/channels/plugins/module-loader.ts", "loadModule"],
      ["src/plugins/module-export.ts", "unwrapDefaultModuleExport"],
      ["src/channels/plugins/merge-plugin-section.ts", undefined],
      ["src/plugins/loader-channel-setup.ts", undefined],
    ] as const) {
      vm.runInContext(
        ownerSource(file, name).replaceAll("import.meta.url", JSON.stringify(import.meta.url)),
        context,
      );
    }
    const ownerName =
      owner === "channel" ? "loadChannelPluginModule" : "loadSetupRuntimeChannelCandidate";
    const source = ownerSource(
      owner === "channel"
        ? "src/channels/plugins/module-loader.ts"
        : "src/plugins/loader-channel-runtime.ts",
      ownerName,
    );
    const invoke = (modulePath: string, rootDir = plugin, rejectHardlinks = false) => {
      errors.length = 0;
      if (owner === "channel") {
        return context.loadChannelPluginModule({ modulePath, rootDir });
      }
      channels.length = 0;
      context.loadSetupRuntimeChannelCandidate({
        mod: {
          kind: "bundled-channel-setup-entry",
          loadSetupPlugin: () => ({ id: "example", meta: { setup: true } }),
        },
        manifestRecord: { setupSource: "setup.js", channels: ["example"] },
        record: { id: "example" },
        registrationPlan: { loadSetupEntry: true, loadSetupRuntimeEntry: true },
        runtimeCandidateEntry: { source: modulePath, rootDir },
        safeSource: "setup.js",
        rejectHardlinks,
        loadPluginModule: loadModule,
        registryBuilder: {
          createApi: () => ({ registerChannel: (channel: unknown) => channels.push(channel) }),
          registry: { plugins: [] },
        },
        cfg: {},
        seenIds: new Map(),
        pushPluginLoadError: (error: string) => errors.push(error),
      });
      if (errors.length) {
        throw new Error(errors.join("\n"));
      }
      return channels[0];
    };
    vm.runInContext(source, context);
    expect(() => invoke(entry)).toThrow(
      owner === "channel" ? "plugin module path" : "plugin entry path",
    );
    expect(loadModule).not.toHaveBeenCalled();
    open.mockClear();
    const imports =
      'import { s as secureOpen } from "./admission-export.js";\nimport fsAlias from "node:fs";\n';
    fs.writeFileSync(
      path.join(runtime, "dist/admission-export.js"),
      `${ownerSource("src/plugins/path-safety.ts", "openPluginRootFileSync")}\nexport { openPluginRootFileSync as s };\n`,
    );
    const input =
      format === "imported"
        ? imports +
          source
            .replaceAll("openPluginRootFileSync(", "secureOpen(")
            .replaceAll("fs.closeSync", "fsAlias.closeSync")
        : format === "minified"
          ? transformSync(source, {
              minifyIdentifiers: true,
              minifySyntax: true,
              minifyWhitespace: true,
            }).code
          : source;
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/channel-owner.js"),
      contents: input,
    });
    vm.runInContext(transformed.contents.replace(imports, ""), context);
    expect(invoke(entry)).toEqual(
      owner === "channel" ? moduleExport : { id: "example", meta: { runtime: true, setup: true } },
    );
    expect(open).not.toHaveBeenCalled();
    if (owner === "channel") {
      expect(invoke(entry)).toBe(moduleExport);
      expect(loadModule).toHaveBeenCalledOnce();
    }

    const externalRoot = path.join(runtime, "external-channel");
    fs.mkdirSync(externalRoot);
    const external = path.join(externalRoot, "index.cjs");
    fs.writeFileSync(
      external,
      'module.exports = { kind: "bundled-channel-entry", id: "example", loadChannelPlugin: () => ({id: "example"}) };\n',
    );
    expect(invoke(external, externalRoot)).toMatchObject({ id: "example" });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ filePath: external }));
    const escape = path.join(plugin, "escape.cjs");
    fs.symlinkSync(external, escape);
    expect(() => invoke(escape)).toThrow();
    if (owner === "setup") {
      const hardlink = path.join(externalRoot, "hardlink.cjs");
      fs.linkSync(external, hardlink);
      expect(() => invoke(hardlink, externalRoot, true)).toThrow();
    }
    expect(loadModule).toHaveBeenCalledTimes(2);
  });

  it.each(
    (["source", "minified", "typed"] as const).flatMap((shape) =>
      (["cli", "containment"] as const).map((owner) => ({ owner, shape })),
    ),
  )("resolves $owner paths from image facts ($shape)", ({ owner, shape }) => {
    const typed = shape === "typed";
    const { runtime, plugin, entry, context, adapter } = fixture({ typedMetadata: typed });
    const realpath = vi.fn((filename: string) => fs.realpathSync(filename));
    const lstat = vi.fn((filename: string) => fs.lstatSync(filename));
    Object.assign(context, {
      fs: { realpathSync: realpath, lstatSync: lstat },
      isPathInside,
      safeRealpathSync,
    });
    const source =
      owner === "cli"
        ? ownerSource("src/infra/openclaw-cli-invocation.ts", "resolveOpenClawCliEntryPath", typed)
        : ownerSource("src/plugins/plugin-registry-comparison.ts", "isContainedPluginPath", typed);
    const invoke = (target: string) =>
      owner === "cli"
        ? context.resolveOpenClawCliEntryPath(target)
        : context.isContainedPluginPath(plugin, target, new Map());
    vm.runInContext(typed ? stripTypeScriptTypes(source) : source, context);
    expect(invoke(entry)).toBe(owner === "cli" ? entry : true);
    expect((owner === "cli" ? realpath : lstat).mock.calls).toContainEqual([entry]);
    realpath.mockClear();
    lstat.mockClear();
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/path-owner.js"),
      contents:
        shape === "minified"
          ? transformSync(source, {
              minifyIdentifiers: true,
              minifySyntax: true,
              minifyWhitespace: true,
            }).code
          : source,
    });
    vm.runInContext(
      typed ? stripTypeScriptTypes(transformed.contents) : transformed.contents,
      context,
    );
    expect(invoke(entry)).toBe(owner === "cli" ? entry : true);
    expect(realpath).not.toHaveBeenCalled();
    expect(lstat).not.toHaveBeenCalled();

    const external = path.join(runtime, "external-target");
    fs.mkdirSync(external);
    const target = path.join(external, "index.js");
    fs.writeFileSync(target, "export {};\n");
    const escape = path.join(plugin, "escape.js");
    fs.symlinkSync(target, escape);
    expect(invoke(escape)).toBe(owner === "cli" ? target : false);
    expect((owner === "cli" ? realpath : lstat).mock.calls).toContainEqual([escape]);
    if (owner === "containment") {
      const escapeDirectory = path.join(plugin, "escape-directory");
      fs.symlinkSync(external, escapeDirectory);
      expect(invoke(path.join(escapeDirectory, "missing.js"))).toBe(false);
      expect(invoke(path.join(plugin, "missing.js"))).toBe(true);
    }
  });

  it.each([false, true])(
    "detects embedded main entries without native realpath probes (minified=%s)",
    (minified) => {
      const { runtime, launcher, mainEntry, context, adapter } = fixture();
      const native = vi.fn((filename: string) => fs.realpathSync.native(filename));
      context.fs = { realpathSync: { native } };
      context.tryProcessCwd = tryProcessCwd;
      const source = ownerSource("src/infra/is-main.ts");
      vm.runInContext(source, context);
      const launch = {
        currentFile: mainEntry,
        argv: [process.execPath, launcher],
        env: {},
        wrapperEntryPairs: [{ wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" }],
      };
      expect(context.isMainModule(launch)).toBe(true);
      expect(native.mock.calls).toEqual([[mainEntry], [launcher]]);
      native.mockClear();
      const transformed = adapter.transform({
        filename: path.join(runtime, "dist/is-main.js"),
        contents: minified
          ? transformSync(source, {
              minifyIdentifiers: true,
              minifySyntax: true,
              minifyWhitespace: true,
            }).code
          : source,
      });
      vm.runInContext(transformed.contents, context);
      expect(context.isMainModule(launch)).toBe(true);
      expect(native).not.toHaveBeenCalled();

      const external = path.join(runtime, "external-main.js");
      const link = path.join(runtime, "external-bin");
      fs.writeFileSync(external, "export {};\n");
      fs.symlinkSync(external, link);
      expect(
        context.isMainModule({ ...launch, currentFile: external, argv: [process.execPath, link] }),
      ).toBe(true);
      expect(native.mock.calls).toEqual([[external], [link]]);

      const redirected = path.join(runtime, "redirected-dist");
      fs.mkdirSync(redirected);
      const redirectedEntry = path.join(redirected, "entry.js");
      fs.writeFileSync(redirectedEntry, "export {};\n");
      fs.renameSync(path.join(runtime, "dist"), path.join(runtime, "original-dist"));
      fs.symlinkSync(redirected, path.join(runtime, "dist"));
      native.mockClear();
      expect(context.normalizePathCandidate(mainEntry, runtime)).toBe(redirectedEntry);
      expect(native.mock.calls).toEqual([[mainEntry]]);
    },
  );

  it.each(
    ([false, true] as const).flatMap((minified) =>
      (["runtime", "legacy", "companion"] as const).map((owner) => ({ owner, minified })),
    ),
  )("admits $owner entries without disk JavaScript (minified=$minified)", ({ owner, minified }) => {
    const { runtime, plugin, entry, providerPolicy, context, adapter } = fixture({
      withPublicSurface: true,
    });
    const errors: string[] = [];
    const open = vi.fn(openRootFileSync);
    const loadModule = vi.fn((filename: string) => ({ filename }));
    const resolveArtifact = (params: { source: string; rootDir: string }) => params;
    Object.assign(context, {
      performance,
      PluginDashboardDeclarationError,
      resolveImmutableInstallIdentity,
      resolvePluginCandidateInstallOwner,
      openRootFileSync: open,
      openPluginRootFileSync: vi.fn(openPluginRootFileSync),
      describeRootFileOpenFailure,
      shouldRejectHardlinkedPluginFiles,
      resolvePluginRuntimeArtifact: resolveArtifact,
      resolvePluginRuntimeExecutionArtifact: resolveArtifact,
      getCachedPluginModuleLoader: () => loadModule,
      resolveLegacySessionSurface: (value: unknown) => value,
      createBundledEntryModulePathCacheKey: (url: string, specifier: string) =>
        `${url}\0${specifier}`,
      resolveEntryBoundaryRoot: (url: string) => path.dirname(fileURLToPath(url)),
      resolveBundledEntryModuleCandidates: (url: string, specifier: string) => [
        { path: path.resolve(path.dirname(fileURLToPath(url)), specifier), boundaryRoot: plugin },
      ],
      getPluginCacheRoot: () => ({ entryPaths: new Map() }),
      formatBundledEntryModuleOpenFailure: () => "entry admission failed",
      preparePluginLoadRecord: ({ candidate }: { candidate: { source: string } }) => ({
        pluginId: "example",
        activationState: {},
        enableState: { enabled: true },
        record: { id: "example", source: candidate.source },
      }),
      resolveRealpathOrAbsolute: (value: string) => fs.realpathSync(value),
      findActiveDegradedPlugin: () => undefined,
      resolveManifestOwnerBasePolicyBlock: () => null,
      hasExplicitManifestOwnerTrust: () => false,
      resolveExternalPluginRuntimeDependencyRepairHint: () => undefined,
      resolvePluginRegistrationPlan: () => ({ mode: "full" }),
      resolveConfiguredRuntimePluginInstallCandidate: () => undefined,
      resolveCompatibilityHostVersion: () => "2026.10.14",
      prefersBuiltPluginArtifacts: () => true,
      bindPluginRuntimeArtifactSelection: () => ({}),
      recordImportedPluginId: () => {},
      withProfile: (_params: unknown, _label: string, callback: () => unknown) => callback(),
      getPluginInstance: () => undefined,
      loadSetupRuntimeChannelCandidate: () => true,
      recordPluginError: ({ error }: { error: string }) => errors.push(error),
      detailPluginStartupTrace: () => {},
    });
    const ownerFile =
      owner === "runtime"
        ? "src/plugins/loader-runtime-candidate.ts"
        : owner === "legacy"
          ? "src/plugins/legacy-session-surfaces.ts"
          : "src/plugin-sdk/channel-entry-contract.ts";
    const ownerName =
      owner === "runtime"
        ? "loadRuntimePluginCandidate"
        : owner === "legacy"
          ? "loadLegacySessionSurface"
          : "resolveBundledEntryModulePath";
    if (owner === "runtime") {
      vm.runInContext(ownerSource(ownerFile, "prepareRuntimePluginConfig"), context);
    }
    const source = ownerSource(ownerFile, ownerName).replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(path.join(runtime, "dist/owner.js")).href),
    );
    const invoke = (sourcePath: string, origin = "bundled", rootDir = plugin) => {
      errors.length = 0;
      let result: unknown;
      if (owner === "runtime") {
        const steps = context.loadRuntimePluginCandidate({
          candidate: { source: sourcePath, rootDir, origin },
          manifestRecord: { channels: [], configSchema: {} },
          context: {
            normalized: { slots: {} },
            shouldLoadModules: true,
            installRecords: {},
            env: {},
          },
          options: {},
          state: { seenIds: new Map(), pluginLoadAttemptCount: 0 },
          preparedConfig: { validation: { ok: true } },
          registryBuilder: {
            registry: { plugins: [] },
            rollbackPluginGlobalSideEffects: () => {},
          },
          logger: {},
          loadPluginModule: loadModule,
        });
        let step = steps.next();
        while (!step.done) {
          step = steps.next();
        }
        result = loadModule.mock.calls.at(-1)?.[0];
      } else if (owner === "legacy") {
        result = context.loadLegacySessionSurface({
          record: { id: "example", rootDir, origin },
          setupSource: sourcePath,
          env: {},
          artifactRegistry: {},
        }).filename;
      } else {
        context.resolveBundledEntryModuleCandidates = () => [
          { path: sourcePath, boundaryRoot: rootDir },
        ];
        result = context.resolveBundledEntryModulePath(pathToFileURL(entry).href, sourcePath);
      }
      if (errors.length) {
        throw new Error(errors.join("\n"));
      }
      return result;
    };
    const imageEntry = owner === "companion" ? providerPolicy : entry;
    vm.runInContext(source, context);
    expect(() => invoke(imageEntry)).toThrow();
    expect(loadModule).not.toHaveBeenCalled();
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/owner.js"),
      contents: minified
        ? transformSync(source, {
            minifyIdentifiers: true,
            minifySyntax: true,
            minifyWhitespace: true,
          }).code
        : source,
    });
    vm.runInContext(transformed.contents, context);
    expect(invoke(imageEntry)).toBe(imageEntry);

    const externalRoot = path.join(runtime, "external-entry");
    fs.mkdirSync(externalRoot);
    const external = path.join(externalRoot, "index.js");
    fs.writeFileSync(external, "export default {};\n");
    expect(invoke(external, "global", externalRoot)).toBe(external);
    const escape = path.join(plugin, "escape.js");
    fs.symlinkSync(external, escape);
    expect(() => invoke(escape)).toThrow();
    if (owner !== "companion") {
      const hardlink = path.join(externalRoot, "hardlink.js");
      fs.linkSync(external, hardlink);
      expect(() => invoke(hardlink, "global", externalRoot)).toThrow();
    }
    expect(loadModule).toHaveBeenCalledTimes(owner === "companion" ? 0 : 2);
  });

  it.each([
    { minified: false, localIdentity: false },
    { minified: true, localIdentity: false },
    { minified: true, localIdentity: true },
  ])(
    "admits public surfaces through the secure loader (minified=$minified, localIdentity=$localIdentity)",
    ({ minified, localIdentity }) => {
      const { runtime, plugin, providerPolicy, context, adapter } = fixture({
        withPublicSurface: true,
      });
      const cache = {
        sources: new Map(),
        sourceAliases: new Map(),
        roots: new Map(),
        rootAliases: new Map(),
      };
      const open = vi.fn(openPluginRootFileSync);
      const require = createRequire(import.meta.url);
      const loadModule = vi.fn((filename: string) =>
        filename === providerPolicy ? { marker: "embedded" } : require(filename),
      );
      Object.assign(context, {
        getPluginCache: () => cache,
        openPluginRootFileSync: open,
        sameFileIdentity,
        shouldRejectHardlinkedPluginFiles,
        getPluginInstance: () => undefined,
        resolvePluginRuntimeRecord: () => undefined,
        getPluginRuntimeGatewayRequestScope: () => undefined,
        getCachedPluginModuleLoader: () => loadModule,
      });
      for (const name of [
        "getPluginCacheRoot",
        "mergeRootFacts",
        "bindPluginCacheRoot",
        "getPluginCacheSource",
      ]) {
        vm.runInContext(ownerSource("src/plugins/plugin-cache.ts", name), context);
      }
      for (const [file, name] of [
        ["src/plugins/plugin-module-loader-cache.ts", "resolvePublicSurfaceInstance"],
        ["src/plugins/plugin-module-loader-cache.ts", "preparePluginModule"],
        ["src/plugins/plugin-module-loader-cache.ts", "loadPluginPublicSurfaceModuleSync"],
        ["src/plugin-sdk/facade-loader.ts", "loadFacadeModuleAtLocationSync"],
        ["src/plugins/public-surface-loader.ts", "loadValidatedPublicSurfaceModule"],
      ] as const) {
        vm.runInContext(
          ownerSource(file, name).replaceAll(
            "import.meta.url",
            JSON.stringify(pathToFileURL(path.join(runtime, "dist/loader.js")).href),
          ),
          context,
        );
      }
      const params = {
        modulePath: providerPolicy,
        boundaryRoot: plugin,
        origin: "bundled",
        surfaceLabel: "bundled plugin public surface example/provider-policy-api.js",
      };
      expect(() => context.loadValidatedPublicSurfaceModule(params)).toThrow(
        "Unable to open bundled plugin public surface",
      );
      expect(open).toHaveBeenCalled();
      open.mockClear();
      let source = ownerSource("src/plugins/plugin-module-loader-cache.ts", "preparePluginModule");
      if (localIdentity) {
        source = `function bundledIdentityCheck(left, right) {
          return sameFileIdentity(left, right);
        }\n${source.replace("sameFileIdentity(", "bundledIdentityCheck(")}`;
      }
      const transformed = adapter.transform({
        filename: path.join(runtime, "dist/plugin-module-loader-cache.js"),
        contents: minified
          ? transformSync(source, {
              minifyIdentifiers: true,
              minifySyntax: true,
              minifyWhitespace: true,
            }).code
          : source,
      });
      vm.runInContext(transformed.contents, context);
      const first = context.loadValidatedPublicSurfaceModule(params);
      expect(first).toEqual({ marker: "embedded" });
      expect(context.loadValidatedPublicSurfaceModule(params)).toBe(first);
      expect(open).not.toHaveBeenCalled();
      expect(loadModule).toHaveBeenCalledOnce();
      expect(cache.sourceAliases.get(providerPolicy)).toBe(providerPolicy);
      expect(
        context.getPluginCacheSource(providerPolicy).validatedBoundaries.has(`${plugin}\0false`),
      ).toBe(true);

      const externalRoot = path.join(runtime, "external-public-surface");
      fs.mkdirSync(externalRoot);
      const external = path.join(externalRoot, "api.cjs");
      fs.writeFileSync(external, 'module.exports = { marker: "external" };\n');
      const externalParams = {
        ...params,
        modulePath: external,
        boundaryRoot: externalRoot,
        origin: "global",
      };
      expect(context.loadValidatedPublicSurfaceModule(externalParams)).toEqual({
        marker: "external",
      });
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: external, rejectHardlinks: true }),
      );
      const escape = path.join(plugin, "escape.cjs");
      fs.symlinkSync(external, escape);
      expect(() =>
        context.loadValidatedPublicSurfaceModule({ ...params, modulePath: escape }),
      ).toThrow("Unable to open");
      const hardlink = path.join(externalRoot, "hardlink.cjs");
      fs.linkSync(external, hardlink);
      expect(() =>
        context.loadValidatedPublicSurfaceModule({ ...externalParams, modulePath: hardlink }),
      ).toThrow("Unable to open");
      expect(loadModule).toHaveBeenCalledTimes(2);
    },
  );

  it("retains metadata directories without retaining dependency namespaces", () => {
    const { adapter } = fixture({ withPublicSurfaces: true });
    expect(adapter.directories).toContain("dist/state");
    expect(adapter.directories).toContain("extensions/example");
    expect(
      adapter.directories.some((directory: string) => directory.includes("node_modules")),
    ).toBe(false);
  });

  it.each(["source", "compiled", "typed"])(
    "admits embedded SQLite worker identity (%s)",
    async (shape) => {
      const typed = shape === "typed";
      const { runtime, sqliteWorker, context, adapter } = fixture({ typedMetadata: typed });
      const realpath = vi.fn((filename: string) => fs.promises.realpath(filename));
      const stat = vi.fn((filename: string) => fs.promises.stat(filename));
      Object.assign(context, {
        realpath,
        stat,
        qe: realpath,
        We: fileURLToPath,
        Ge: pathToFileURL,
        Je: stat,
      });
      // Captured worker output retains the owner name and shortens imported filesystem helpers.
      const contents =
        shape !== "compiled"
          ? ownerSource(
              "src/infra/sqlite-worker-broker-admission.ts",
              "resolveSqliteWorkerModuleUrl",
              typed,
            )
          : String.raw`async function resolveSqliteWorkerModuleUrl(e){let t=await qe(We(e)),n=Ge(t).href;if(!/\.[cm]?[jt]s$/.test(t)||!(await Je(t)).isFile())throw Error("SQLite worker backend must identify a JavaScript or TypeScript file");return{modulePath:t,moduleUrl:n}}`;
      vm.runInContext(typed ? stripTypeScriptTypes(contents) : contents, context);
      await expect(
        context.resolveSqliteWorkerModuleUrl(pathToFileURL(sqliteWorker)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      realpath.mockClear();
      stat.mockClear();
      const transformed = adapter.transform({
        filename: path.join(runtime, "dist/owner.js"),
        contents,
      });
      vm.runInContext(
        typed ? stripTypeScriptTypes(transformed.contents) : transformed.contents,
        context,
      );
      fs.rmdirSync(path.dirname(sqliteWorker));
      const realpathSync = vi.spyOn(fs, "realpathSync");
      const lstatSync = vi.spyOn(fs, "lstatSync");
      try {
        expect(await context.resolveSqliteWorkerModuleUrl(pathToFileURL(sqliteWorker))).toEqual({
          modulePath: sqliteWorker,
          moduleUrl: pathToFileURL(sqliteWorker).href,
        });
        expect(realpath).not.toHaveBeenCalled();
        expect(stat).not.toHaveBeenCalled();
        expect(realpathSync).not.toHaveBeenCalled();
        expect(lstatSync).not.toHaveBeenCalled();
      } finally {
        realpathSync.mockRestore();
        lstatSync.mockRestore();
      }
      const external = path.join(runtime, "external-worker.mjs");
      fs.writeFileSync(external, "export {};\n");
      const alias = path.join(runtime, "external-alias.mjs");
      fs.symlinkSync(external, alias);
      expect(await context.resolveSqliteWorkerModuleUrl(pathToFileURL(alias))).toEqual({
        modulePath: external,
        moduleUrl: pathToFileURL(external).href,
      });
      expect(realpath).toHaveBeenCalledWith(alias);
      expect(stat).toHaveBeenCalledWith(external);
      fs.mkdirSync(path.dirname(sqliteWorker));
      fs.symlinkSync(external, sqliteWorker);
      realpath.mockClear();
      stat.mockClear();
      expect(await context.resolveSqliteWorkerModuleUrl(pathToFileURL(sqliteWorker))).toEqual({
        modulePath: sqliteWorker,
        moduleUrl: pathToFileURL(sqliteWorker).href,
      });
      expect(realpath).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
      const directory = path.join(runtime, "directory.js");
      fs.mkdirSync(directory);
      await expect(context.resolveSqliteWorkerModuleUrl(pathToFileURL(directory))).rejects.toThrow(
        "SQLite worker backend must identify a JavaScript or TypeScript file",
      );
    },
  );

  it("leaves prototype-named functions unchanged in minified metadata modules", () => {
    const { runtime, entry, context, adapter } = fixture();
    const source = transformSync(
      `function valueOf(value) { return value + 1; }
       function constructor(value) { return value * 2; }
       ${ownerSource("src/plugins/plugin-cache-files.ts", "pluginCacheExistsSync")}`,
      { minifyIdentifiers: true, minifySyntax: true, minifyWhitespace: true },
    ).code;
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/minified-metadata.js"),
      contents: source,
    });
    vm.runInContext(transformed.contents, context);
    expect(vm.runInContext("[valueOf(4), constructor(3)]", context)).toEqual([5, 6]);
    expect(context.pluginCacheExistsSync(entry)).toBe(true);
  });

  it.each([
    { minifiedMetadata: false, typedMetadata: false },
    { minifiedMetadata: true, typedMetadata: false },
    { minifiedMetadata: false, typedMetadata: true },
  ])(
    "admits embedded plugin sources and caches Doctor bytes (minified=$minifiedMetadata, typed=$typedMetadata)",
    ({ minifiedMetadata, typedMetadata }) => {
      const { plugin, entry, doctor, doctorBytes, context, safeOpen } = fixture({
        minifiedMetadata,
        typedMetadata,
      });
      expect(context.pluginCacheExistsSync(entry)).toBe(true);
      expect(context.pluginCacheStatSync(entry).isFile()).toBe(true);
      expect(context.pluginCacheLstatSync(entry).isSymbolicLink()).toBe(false);
      expect(context.pluginCacheRealpathSync(entry)).toBe(entry);
      expect(
        context.checkPluginCacheEntry({
          rootDir: plugin,
          relativePath: "index.js",
          rejectHardlinks: true,
        }),
      ).toEqual({ ok: true, exists: true, path: entry, rootRealPath: plugin });
      const imageRead = vi.fn(context["__openclawStandaloneImageRead"]);
      context["__openclawStandaloneImageRead"] = imageRead;
      const file = context.readPluginCacheFile({
        rootDir: plugin,
        relativePath: "doctor-contract-api.js",
        rejectHardlinks: true,
      });
      expect(file.contents).toEqual(doctorBytes);
      expect(
        context.readPluginCacheFile({
          rootDir: plugin,
          relativePath: "doctor-contract-api.js",
          rejectHardlinks: true,
        }),
      ).toBe(file);
      expect(imageRead).toHaveBeenCalledOnce();
      expect(context.fileContentMatches(doctor, file.hash)).toBe(true);
      expect(context.fileContentMatches(doctor, "different-build")).toBe(false);
      expect(
        context.readPluginCacheFile({
          rootDir: plugin,
          relativePath: "doctor-contract-api.js",
          rejectHardlinks: true,
          maxBytes: 1,
        }).ok,
      ).toBe(false);
      expect(safeOpen).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps external plugin admission physical (minified=%s)",
    (minifiedMetadata) => {
      const { runtime, plugin, context, safeOpen } = fixture({ minifiedMetadata });
      const external = path.join(runtime, "external");
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, "index.js"), "external");
      expect(
        context.checkPluginCacheEntry({
          rootDir: external,
          relativePath: "index.js",
          rejectHardlinks: true,
        }).ok,
      ).toBe(false);
      expect(
        context.checkPluginCacheEntry({
          rootDir: external,
          relativePath: "../dist/extensions/example/index.js",
          rejectHardlinks: true,
        }).ok,
      ).toBe(false);
      const alias = path.join(runtime, "alias");
      fs.symlinkSync(plugin, alias);
      expect(
        context.readPluginCacheFile({
          rootDir: alias,
          relativePath: "doctor-contract-api.js",
          rejectHardlinks: true,
        }).ok,
      ).toBe(false);
      expect(safeOpen).toHaveBeenCalledTimes(3);
    },
  );

  it("preserves public file discovery", () => {
    const { plugin, context } = fixture();
    const entries = context.readPluginCacheDirectory(plugin);
    expect(entries.map((entry: fs.Dirent) => entry.name).toSorted()).toEqual([
      "doctor-contract-api.js",
      "handlers",
      "index.js",
      "openclaw.plugin.json",
      "package.json",
    ]);
  });

  it.each([false, true])(
    "selects compiled package API aliases with physical sources=%s",
    (retainSourceFiles) => {
      const { runtime, plugin, context, adapter } = fixture({
        withPublicSurfaces: true,
        retainSourceFiles,
      });
      context.openPluginRootFileSync = openPluginRootFileSync;
      for (const name of [
        "BUNDLED_PLUGIN_PUBLIC_SURFACE_SOURCE_PATTERN",
        "sdkHost",
        "readSdkJsonFile",
        "readPluginSdkPackageJson",
        "readBundledPluginPackageName",
        "listBundledPluginPublicSurfaceSourceBasenames",
        "resolveBundledPluginPublicSurfaceAliasTarget",
        "normalizeJitiAliasTargetPath",
        "resolveBundledPluginPackagePublicSurfaceAliasMap",
      ]) {
        const transformed = adapter.transform({
          filename: path.join(runtime, "dist/sdk-owner.js"),
          contents: ownerSource("src/plugins/sdk-alias.ts", name),
        });
        vm.runInContext(transformed.contents, context);
      }
      const aliases = (packageRoot: string, includePrivateQa = false) =>
        context.resolveBundledPluginPackagePublicSurfaceAliasMap({
          packageRoot,
          orderedKinds: ["src", "dist"],
          includePrivateQa,
        });
      expect(fs.existsSync(path.join(runtime, "extensions/example/api.ts"))).toBe(
        retainSourceFiles,
      );
      expect(fs.existsSync(path.join(plugin, "api.js"))).toBe(false);
      expect(aliases(runtime)).toEqual({
        "@openclaw/example/api.js": path.join(plugin, "api.js"),
        "@openclaw/example/diagnostics-api.js": path.join(plugin, "diagnostics-api.js"),
        "@openclaw/example/runtime-api.js": path.join(plugin, "runtime-api.js"),
      });
      expect(aliases(runtime, true)).toEqual({
        ...aliases(runtime),
        "@openclaw/example/test-api.js": path.join(plugin, "test-api.js"),
      });

      const externalRoot = path.join(runtime, "external-host");
      const externalPlugin = path.join(externalRoot, "extensions/external");
      fs.mkdirSync(externalPlugin, { recursive: true });
      fs.writeFileSync(path.join(externalPlugin, "package.json"), '{"name":"@openclaw/external"}');
      fs.writeFileSync(path.join(externalPlugin, "api.ts"), "export {};\n");
      expect(aliases(externalRoot)).toEqual({
        "@openclaw/external/api.js": path.join(externalPlugin, "api.ts"),
      });
    },
  );

  it("resolves absent image-only directories without accepting symlink escapes", () => {
    const { runtime, sdk, sdkEntry, context, safeOpen } = fixture();
    fs.rmdirSync(sdk);
    expect(context.pluginCacheExistsSync(sdk)).toBe(true);
    expect(context.pluginCacheStatSync(sdk).isDirectory()).toBe(true);
    const failure = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const stat = vi.spyOn(fs, "statSync").mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => context["__openclawStandaloneImageStat"](sdk)).toThrow(failure);
    } finally {
      stat.mockRestore();
    }
    expect(context.pluginCacheRealpathSync(sdk)).toBe(sdk);
    expect(context.readPluginCacheDirectory(sdk).map((entry: fs.Dirent) => entry.name)).toEqual([
      "example.js",
    ]);
    expect(
      context.checkPluginCacheEntry({
        rootDir: sdk,
        relativePath: "example.js",
        rejectHardlinks: true,
      }),
    ).toEqual({ ok: true, path: sdkEntry, rootRealPath: sdk, exists: true });
    const external = path.join(runtime, "external-sdk");
    fs.mkdirSync(external);
    fs.symlinkSync(external, sdk);
    expect(
      context.checkPluginCacheEntry({
        rootDir: sdk,
        relativePath: "example.js",
        rejectHardlinks: true,
      }).ok,
    ).toBe(false);
    expect(safeOpen).toHaveBeenCalledOnce();
  });

  it("recognizes the filesystem import aliases emitted by bundled chunks", () => {
    const { runtime, plugin, context, adapter } = fixture();
    context.fsSync = context.fs;
    const contents =
      'import fsSync from "node:fs";\n' +
      ownerSource("src/plugins/plugin-cache-files.ts", "readPluginCacheDirectory").replaceAll(
        "fs.readdirSync",
        "fsSync.readdirSync",
      );
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/aliased.js"),
      contents,
    });
    vm.runInContext(transformed.contents.replace('import fsSync from "node:fs";', ""), context);
    expect(
      context
        .readPluginCacheDirectory(plugin)
        .map((entry: fs.Dirent) => entry.name)
        .toSorted(),
    ).toEqual([
      "doctor-contract-api.js",
      "handlers",
      "index.js",
      "openclaw.plugin.json",
      "package.json",
    ]);
  });

  it("resolves metadata helper imports through the TypeScript source owner", () => {
    const { runtime, embeddedPaths, plugin, context } = fixture({ retainImageFiles: true });
    const sourceRoot = path.join(runtime, ".typed-source/context/src");
    const helper = path.join(sourceRoot, "boundary.ts");
    const filename = path.join(sourceRoot, "entry.ts");
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      helper,
      "declare function openRootFileSync(value: unknown): unknown; export { openRootFileSync as open };\n",
    );
    const source = `import { open } from "./boundary.js";
function loadLegacySessionSurface(rootPath: string) {
  return open({ rootPath, absolutePath: rootPath + "/index.js" });
}`;
    const adapter = createStandaloneMetadataAdapter({
      runtimeRoot: runtime,
      embeddedPaths,
      parse,
      resolveImport(specifier: string, importer: string) {
        expect(specifier).toBe("./boundary.js");
        expect(importer).toBe(filename);
        return helper;
      },
    });
    const transformed = adapter.transform({ filename, contents: source });
    const open = vi.fn(() => "disk fallback");
    context.open = open;
    vm.runInContext(
      stripTypeScriptTypes(
        transformed.contents.replace('import { open } from "./boundary.js";', ""),
      ),
      context,
    );
    expect(context.loadLegacySessionSurface(plugin)).toMatchObject({
      ok: true,
      path: path.join(plugin, "index.js"),
    });
    expect(open).not.toHaveBeenCalled();
    expect(context.loadLegacySessionSurface(path.join(runtime, "external"))).toBe("disk fallback");
    expect(open).toHaveBeenCalledOnce();
  });

  it("preserves physical directory permissions and symlink types in image metadata", () => {
    const { plugin, sdk, runtime, context } = fixture();
    fs.chmodSync(plugin, 0o777);
    expect(context.pluginCacheStatSync(plugin).mode & 0o777).toBe(0o777);
    expect(context.pluginCacheLstatSync(plugin).uid).toBe(fs.lstatSync(plugin).uid);
    fs.rmdirSync(sdk);
    const target = path.join(runtime, "sdk-target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, sdk);
    expect(context.pluginCacheLstatSync(sdk).isSymbolicLink()).toBe(true);
    expect(context.pluginCacheStatSync(sdk).isDirectory()).toBe(true);
  });

  it("discovers and prepares a bundled hook with its handler only in the executable", async () => {
    const { runtime, hookDir, hookHandler, context, adapter, rootOpen } = fixture();
    const entry = context.loadHookFromDir({ hookDir, source: "openclaw-bundled" });
    expect(entry.hook.handlerPath).toBe(hookHandler);
    expect(entry.metadata.events).toEqual(["command:new"]);
    expect(rootOpen.mock.calls.some(([params]) => params.absolutePath === hookHandler)).toBe(false);
    const importHandler = vi.fn(async () => ({ default: () => {} }));
    Object.assign(context, {
      hookOwner: { generation: { registrations: [] } },
      isHookLoadable: () => true,
      resolveInternalHookSelection: async () => ({ configured: true }),
      prepareWorkspaceHookEntries: () => ({ entries: [entry], sources: [] }),
      safeRealpathSync: (name: string) => fs.realpathSync(name),
      openRootFile: async () => {
        throw new Error("Unexpected physical handler open");
      },
      log: { debug: () => {}, warn: () => {} },
      isKnownInternalHookEventKey: () => true,
      resolveFunctionModuleExport: ({ mod }: { mod: { default: unknown } }) => mod.default,
      safeLogValue: (value: string) => value,
      buildImportUrl: (name: string) => pathToFileURL(name).href,
      __openclawStandaloneImport: importHandler,
    });
    const filename = path.join(runtime, "dist/hooks-loader.js");
    const transformed = adapter.transform({
      filename,
      contents: ownerSource("src/hooks/loader.ts", "prepareInternalHooks"),
    });
    vm.runInContext(
      rewriteStandaloneImports({
        ...transformed,
        filename,
        runtimeRoot: runtime,
        embeddedPaths: {},
        moduleAliases: {},
        workerThreadsShim: "",
        parse,
      }),
      context,
    );
    const prepared = await context.prepareInternalHooks({}, runtime);
    expect(prepared.loadedCount).toBe(1);
    expect(importHandler).toHaveBeenCalledWith(
      pathToFileURL(filename).href,
      pathToFileURL(hookHandler).href,
    );

    expect(
      context.loadHookFromDir({ hookDir, source: "openclaw-managed" }).hook.handlerPath,
    ).toBeUndefined();
    const alias = path.join(runtime, "hook-alias");
    fs.symlinkSync(hookDir, alias);
    expect(
      context["__openclawStandaloneHookEntry"]({
        source: "openclaw-bundled",
        rootPath: alias,
        absolutePath: path.join(alias, "handler.js"),
      }),
    ).toBeUndefined();
    expect(
      context["__openclawStandaloneHookEntry"]({
        source: "openclaw-bundled",
        rootPath: path.join(runtime, "external"),
        absolutePath: hookHandler,
      }),
    ).toBeUndefined();
  });

  it("uses immutable embedded secret entrypoints and keeps external descriptor admission", () => {
    const { runtime, plugin, secretEntrypoint, undeclaredEntrypoint, rootOpen, context } =
      fixture();
    const close = vi.fn(fs.closeSync);
    context.fs = { ...context.fs, closeSync: close };
    const resolve = (pluginRoot: string, entrypoint = "./handlers/resolver.js") =>
      context.resolveNodeEntrypointArg({
        args: [entrypoint],
        pluginRoot,
        rejectHardlinks: true,
      });
    expect(resolve(plugin)).toBe(secretEntrypoint);
    expect(rootOpen).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(resolve(plugin, "./handlers/other.js")).toBeUndefined();
    expect(rootOpen.mock.calls.at(-1)?.[0].absolutePath).toBe(undeclaredEntrypoint);
    fs.chmodSync(path.dirname(secretEntrypoint), 0o777);
    expect(resolve(plugin)).toBe(secretEntrypoint);
    fs.chmodSync(path.dirname(secretEntrypoint), 0o755);
    fs.chmodSync(plugin, 0o777);
    expect(resolve(plugin)).toBe(secretEntrypoint);
    fs.chmodSync(plugin, 0o755);
    expect(resolve(plugin, "../example/handlers/resolver.js")).toBeUndefined();
    const external = path.join(runtime, "external");
    fs.mkdirSync(external);
    const externalEntry = path.join(external, "resolver.js");
    fs.writeFileSync(externalEntry, "export {};\n");
    expect(resolve(external, "./resolver.js")).toBe(externalEntry);
    expect(close).toHaveBeenCalledOnce();
    const opened = rootOpen.mock.results.at(-1)?.value;
    if (!opened?.ok) {
      throw new Error("Expected the physical resolver to own a descriptor");
    }
    expect(close).toHaveBeenLastCalledWith(opened.fd);
    expect(() => fs.fstatSync(opened.fd)).toThrow(/EBADF/);
    close.mockClear();
    fs.chmodSync(external, 0o777);
    expect(resolve(external, "./resolver.js")).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    fs.chmodSync(external, 0o755);
    close.mockClear();
    close.mockImplementationOnce((fd) => {
      fs.closeSync(fd);
      throw new Error("synthetic close failure");
    });
    expect(resolve(external, "./resolver.js")).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    const alias = path.join(runtime, "plugin-alias");
    fs.symlinkSync(plugin, alias);
    expect(resolve(alias)).toBeUndefined();
  });

  it("keeps physical parent trust and symlink checks for disk secret resolvers", () => {
    const embedded = fixture();
    const resolveEmbedded = (pluginRoot: string, entrypoint = "./handlers/resolver.js") =>
      embedded.context.resolveNodeEntrypointArg({
        args: [entrypoint],
        pluginRoot,
        rejectHardlinks: true,
      });
    expect(resolveEmbedded(embedded.plugin)).toBe(embedded.secretEntrypoint);
    expect(embedded.rootOpen).not.toHaveBeenCalled();
    const embeddedAlias = path.join(embedded.runtime, "plugin-alias");
    fs.symlinkSync(embedded.plugin, embeddedAlias);
    expect(resolveEmbedded(embeddedAlias)).toBeUndefined();

    const { runtime, plugin, secretEntrypoint, undeclaredEntrypoint, rootOpen, context } = fixture({
      secretEntrypointOnDisk: true,
    });
    const resolve = (pluginRoot: string, entrypoint = "./handlers/resolver.js") =>
      context.resolveNodeEntrypointArg({
        args: [entrypoint],
        pluginRoot,
        rejectHardlinks: true,
      });
    expect(resolve(plugin, "./handlers/other.js")).toBeUndefined();
    expect(rootOpen.mock.calls.at(-1)?.[0].absolutePath).toBe(undeclaredEntrypoint);
    fs.chmodSync(path.dirname(secretEntrypoint), 0o777);
    expect(resolve(plugin)).toBeUndefined();
    fs.chmodSync(path.dirname(secretEntrypoint), 0o755);
    fs.chmodSync(plugin, 0o777);
    expect(resolve(plugin)).toBeUndefined();
    fs.chmodSync(plugin, 0o755);
    expect(resolve(plugin, "../example/handlers/resolver.js")).toBeUndefined();
    const external = path.join(runtime, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "resolver.js"), "export {};\n");
    expect(resolve(external, "./resolver.js")).toBe(path.join(external, "resolver.js"));
    const outsideEntrypoint = path.join(runtime, "outside-resolver.js");
    fs.writeFileSync(outsideEntrypoint, "export {};\n");
    fs.rmSync(secretEntrypoint);
    fs.symlinkSync(outsideEntrypoint, secretEntrypoint);
    expect(resolve(plugin)).toBeUndefined();
  });

  it("resolves embedded MXC and Vault child entrypoints without probing JavaScript", async () => {
    const { runtime, mxc, mxcLauncher, vault, vaultResolver, context, adapter } = fixture();
    expect(context.resolveMxcLauncherPath(pathToFileURL(path.join(mxc, "index.js")).href)).toBe(
      mxcLauncher,
    );
    const transformed = adapter.transform({
      filename: path.join(runtime, "dist/vault-cli.js"),
      contents: ownerSource("extensions/vault/src/cli.ts", "resolveResolverScriptPath"),
    });
    const diskProbe = vi.fn(() => {
      throw new Error("Unexpected disk path probe");
    });
    context.pathExists = diskProbe;
    vm.runInContext(
      transformed.contents.replaceAll(
        "import.meta.url",
        JSON.stringify(pathToFileURL(path.join(vault, "src/cli.js")).href),
      ),
      context,
    );
    expect(await context.resolveResolverScriptPath()).toBe(vaultResolver);
    expect(diskProbe).not.toHaveBeenCalled();
  });

  it("keeps embedded launcher and ACPX bridge filename probes off disk", () => {
    const { runtime, launcher, bridge, context } = fixture();
    const acpx = path.join(runtime, "dist/extensions/acpx");
    fs.mkdirSync(acpx, { recursive: true });
    fs.writeFileSync(path.join(acpx, "package.json"), "{}");
    fs.writeFileSync(path.join(acpx, "openclaw.plugin.json"), "{}");
    expect(context.candidateDirsFromArgv1(launcher)).toEqual([runtime]);
    expect(
      context.resolveManagedToolsMcpServerConfig(
        "pluginToolsServe",
        pathToFileURL(path.join(acpx, "index.js")).href,
      ),
    ).toEqual({
      command: process.execPath,
      args: process.versions.bun ? ["--no-install", bridge] : [bridge],
    });

    const external = path.join(runtime, "external");
    const externalPlugin = path.join(external, "extensions/acpx");
    fs.mkdirSync(externalPlugin, { recursive: true });
    fs.writeFileSync(path.join(externalPlugin, "package.json"), "{}");
    fs.writeFileSync(path.join(externalPlugin, "openclaw.plugin.json"), "{}");
    const externalBridge = path.join(external, "src/mcp/plugin-tools-serve.ts");
    fs.mkdirSync(path.dirname(externalBridge), { recursive: true });
    fs.writeFileSync(externalBridge, "export {};\n");
    expect(
      context.resolveManagedToolsMcpServerConfig(
        "pluginToolsServe",
        pathToFileURL(path.join(externalPlugin, "index.js")).href,
      ),
    ).toEqual({
      command: process.execPath,
      args: process.versions.bun
        ? ["--no-install", externalBridge]
        : ["--import", import.meta.resolve("tsx"), externalBridge],
    });
    const externalLauncher = path.join(external, "openclaw.mjs");
    fs.writeFileSync(externalLauncher, "external");
    const link = path.join(runtime, "external-launcher");
    fs.symlinkSync(externalLauncher, link);
    expect(context.candidateDirsFromArgv1(link)).toEqual([external, runtime]);
  });
});
