import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePluginNpmRuntimeBuildPlan } from "../../../scripts/lib/plugin-npm-runtime-build.mts";
import { expectNoReaddirSyncDuring } from "../../test-utils/fs-scan-assertions.js";
import {
  listGitTrackedFiles,
  toRepoPath,
  toRepoRelativePath,
} from "../../test-utils/repo-files.js";

const EXTENSION_ROOT = "extensions";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const EXTENSION_RUNTIME_FILE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const BUILTIN_MODULES = new Set(builtinModules.map((moduleId) => moduleId.replace(/^node:/, "")));
const OPTIONAL_UNDECLARED_RUNTIME_IMPORTS = new Map<string, Set<string>>([
  // @discordjs/voice still probes the native addon in its dependency report path.
  ["extensions/discord", new Set(["@discordjs/opus"])],
  ["extensions/qa-lab", new Set(["crabline"])],
]);
const INDIRECT_RUNTIME_DEPENDENCIES = new Map<string, Set<string>>([
  // MCP's server/zod-compat runtime path.
  ["extensions/browser", new Set(["zod"])],
  // Baileys' optional audio decoder peer.
  ["extensions/whatsapp", new Set(["audio-decode"])],
  // LanceDB's runtime peer.
  ["extensions/memory-lancedb", new Set(["apache-arrow"])],
  // Generated memory runtime chunks parse JSON5 config.
  ["extensions/memory-core", new Set(["json5"])],
  // Werift's packaged binary codec.
  ["extensions/openai", new Set(["@shinyoshiaki/binary-data"])],
  // Bolt's Socket Mode requires its Undici 7 peer in the plugin package.
  ["extensions/slack", new Set(["undici"])],
  // Bundled skill exposed by the Tlon manifest.
  ["extensions/tlon", new Set(["@tloncorp/tlon-skill"])],
]);
const COMPUTED_RUNTIME_DEPENDENCIES = new Map<string, Set<string>>([
  // Built into the Activity shell by scripts/build-discord-activity-sdk.mts.
  ["extensions/discord", new Set(["@discord/embedded-app-sdk"])],
  // External to the bundle: the computed core import resolves at runtime.
  ["extensions/lobster", new Set(["@clawdbot/lobster"])],
]);

type DependencyField =
  | "dependencies"
  | "optionalDependencies"
  | "peerDependencies"
  | "devDependencies";
type PackageManifest = Partial<Record<DependencyField, Record<string, string>>> & {
  openclaw?: {
    build?: {
      staticAssets?: Array<{ source?: string }>;
    };
  };
};

function readPackageManifest(filePath: string): PackageManifest {
  return JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, filePath), "utf8")) as PackageManifest;
}

function listTrackedFiles(root: string): string[] {
  const relativeRoot = toRepoRelativePath(REPO_ROOT, path.resolve(REPO_ROOT, root));
  const trackedFiles = listGitTrackedFiles({ repoRoot: REPO_ROOT, pathspecs: relativeRoot });
  expect(trackedFiles, "dependency scans require a Git checkout").not.toBeNull();
  return (trackedFiles ?? []).toSorted();
}

function listPackageManifests(root: string): string[] {
  return listTrackedFiles(root).filter((filePath) =>
    /^extensions\/[^/]+\/package\.json$/u.test(filePath),
  );
}

function shouldSkipRuntimeFile(filePath: string): boolean {
  const normalized = toRepoPath(filePath);
  if (
    ["/node_modules/", "/dist/", "/coverage/", "/assets/"].some((part) =>
      normalized.includes(part),
    ) ||
    // Bundler configs execute during asset preparation, not in the plugin runtime.
    normalized.endsWith("/web/vite.config.ts") ||
    normalized.endsWith("/rolldown.config.mjs")
  ) {
    return true;
  }
  return /(\.(test|spec|d)\.(ts|tsx|js|jsx|mjs|cjs)$|\/(test|tests|__tests__|test-support)\/|test-(api|helpers|support|harness|mocks|fixtures|runtime|shared|utils)|\.test-(api|helpers|support|harness|mocks|fixtures|runtime|shared|utils)|fixture-test-support|mock-setup|test-fixtures|test-runtime-mocks|\.harness\.|e2e-harness|\.mock\.|-mock\.|-mocks\.|mocks-test-support|\.fixture|\.fixtures)/.test(
    normalized,
  );
}

function listRuntimeFiles(root: string): string[] {
  const manifest = readPackageManifest(path.join(root, "package.json"));
  // Static assets execute from the packaged plugin even when a dirty remote sync has not added
  // their new source paths to Git's index, so the manifest must remain an authoritative input.
  const staticAssetSources = (manifest.openclaw?.build?.staticAssets ?? []).flatMap((entry) => {
    const source = entry.source?.trim().replace(/^\.\/+/, "");
    if (!source || source.startsWith("../") || source.includes("/../")) {
      return [];
    }
    const filePath = toRepoPath(path.posix.join(root, source));
    return EXTENSION_RUNTIME_FILE_EXTENSIONS.has(path.extname(filePath)) &&
      !shouldSkipRuntimeFile(filePath) &&
      fs.existsSync(path.resolve(REPO_ROOT, filePath))
      ? [filePath]
      : [];
  });
  return [
    ...new Set([
      ...listTrackedFiles(root).filter(
        (filePath) =>
          EXTENSION_RUNTIME_FILE_EXTENSIONS.has(path.extname(filePath)) &&
          !shouldSkipRuntimeFile(filePath),
      ),
      ...staticAssetSources,
    ]),
  ].toSorted();
}

function readManifestText(root: string): string {
  const resolvedManifestPath = path.resolve(REPO_ROOT, root, "openclaw.plugin.json");
  return fs.existsSync(resolvedManifestPath) ? fs.readFileSync(resolvedManifestPath, "utf8") : "";
}

function packageNameForSpecifier(specifier: string): string | null {
  if (/^(?:[$./]|node:)/.test(specifier) || specifier.includes("${")) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : specifier;
  }
  return specifier.split("/")[0] ?? null;
}

function isTypeOnlyClause(clause: string | undefined): boolean {
  const trimmed = clause?.trim() ?? "";
  if (trimmed.startsWith("type ")) {
    return true;
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return false;
  }
  return trimmed
    .slice(1, -1)
    .split(",")
    .every((part) => !part.trim() || part.trim().startsWith("type "));
}

function collectRuntimeImports(filePath: string): string[] {
  const source = fs.readFileSync(path.resolve(REPO_ROOT, filePath), "utf8");
  const imports = new Set<string>();
  const importRegex =
    /(import|export)\s+([^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source))) {
    const clause = match[2];
    const specifier = match[3] ?? match[4] ?? match[5];
    if (!specifier || (match[1] && isTypeOnlyClause(clause))) {
      continue;
    }
    const packageName = packageNameForSpecifier(specifier);
    if (packageName) {
      imports.add(packageName);
    }
  }
  return [...imports].toSorted();
}

function dependencyNames(
  manifest: PackageManifest,
  fields: readonly DependencyField[] = ["dependencies", "optionalDependencies"],
) {
  return fields.flatMap((field) => Object.keys(manifest[field] ?? {}));
}

function runtimeDependencyNames(manifest: PackageManifest): Set<string> {
  return new Set(
    dependencyNames(manifest, ["dependencies", "optionalDependencies", "peerDependencies"]),
  );
}

function collectBundledRuntimeDependencies(root: string, manifest: PackageManifest) {
  const dependencies = new Map<string, PackageManifest>();
  const entryFiles = new Set<string>();
  const declared = runtimeDependencyNames(manifest);
  const buildDependencies = new Set(
    Object.keys(manifest.devDependencies ?? {}).filter(
      (name) => !name.startsWith("@openclaw/") && !declared.has(name),
    ),
  );
  const plan = buildDependencies.size
    ? resolvePluginNpmRuntimeBuildPlan({ repoRoot: REPO_ROOT, packageDir: root })
    : null;
  if (!plan) {
    return { dependencies, entryFiles };
  }
  const require = createRequire(path.resolve(REPO_ROOT, root, "package.json"));
  const staticAssets = (manifest.openclaw?.build?.staticAssets ?? []).flatMap((asset) =>
    asset.source ? [path.resolve(REPO_ROOT, root, asset.source)] : [],
  );
  for (const filePath of Object.values(plan.entry)) {
    // Copied assets still need installed dependencies; only emitted entrypoints bundle JS.
    if (
      staticAssets.some((asset) => filePath === asset || filePath.startsWith(`${asset}${path.sep}`))
    ) {
      continue;
    }
    entryFiles.add(toRepoPath(path.relative(REPO_ROOT, filePath)));
    for (const name of collectRuntimeImports(filePath)) {
      if (!buildDependencies.has(name) || dependencies.has(name)) {
        continue;
      }
      const packagePath = require.resolve
        .paths(name)
        ?.map((directory) => path.join(directory, name, "package.json"))
        .find((candidate) => fs.existsSync(candidate));
      if (!packagePath) {
        throw new Error(`${root} cannot resolve bundled dependency ${name}`);
      }
      dependencies.set(name, readPackageManifest(packagePath));
    }
  }
  return { dependencies, entryFiles };
}

describe("Discord dependency ownership", () => {
  it.each(
    ["package.json", ...listPackageManifests(EXTENSION_ROOT)].filter(
      (file) => file !== "extensions/discord/package.json",
    ),
  )("%s does not own Discord package dependencies", (file) => {
    const manifest = readPackageManifest(file);
    const names = [
      ...runtimeDependencyNames(manifest),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(
      names.filter((name) => /^(?:discord-api-types$|@discordjs\/|@snazzah\/)/.test(name)),
    ).toStrictEqual([]);
  });
});

describe("extension runtime dependency manifests", () => {
  it("lists extension dependency inputs from git without walking extension dirs", () => {
    expectNoReaddirSyncDuring(() => {
      const manifests = listPackageManifests(EXTENSION_ROOT);
      const runtimeFiles = listRuntimeFiles("extensions/discord");

      expect(manifests.length).toBeGreaterThan(0);
      expect(runtimeFiles.length).toBeGreaterThan(0);
    });
  });

  it("keeps json5 in memory-core for packaged runtime config parsing", () => {
    const manifest = readPackageManifest("extensions/memory-core/package.json");

    expect(manifest.dependencies?.json5).toBeTypeOf("string");
    expect(manifest.dependencies?.json5).not.toBe("");
  });

  for (const [extensionDir, dependencies] of COMPUTED_RUNTIME_DEPENDENCIES) {
    it(`${extensionDir} declares every computed runtime dependency`, () => {
      const manifest = readPackageManifest(path.join(extensionDir, "package.json"));
      const declared = new Set(dependencyNames(manifest));

      expect([...dependencies].filter((dependencyName) => !declared.has(dependencyName))).toEqual(
        [],
      );
    });
  }

  for (const manifestPath of listPackageManifests(EXTENSION_ROOT)) {
    const extensionDir = toRepoPath(path.dirname(manifestPath));

    it(`${extensionDir} declares exactly its runtime dependencies`, () => {
      const manifest = readPackageManifest(manifestPath);
      const declared = runtimeDependencyNames(manifest);
      const bundled = collectBundledRuntimeDependencies(extensionDir, manifest);
      const allowedOptional =
        OPTIONAL_UNDECLARED_RUNTIME_IMPORTS.get(extensionDir) ?? new Set<string>();
      const missing = new Map<string, string[]>();

      for (const filePath of listRuntimeFiles(extensionDir)) {
        for (const packageName of collectRuntimeImports(filePath)) {
          if (
            packageName === "openclaw" ||
            packageName.startsWith("@openclaw/") ||
            BUILTIN_MODULES.has(packageName) ||
            declared.has(packageName) ||
            (bundled.entryFiles.has(filePath) && bundled.dependencies.has(packageName)) ||
            allowedOptional.has(packageName)
          ) {
            continue;
          }
          const files = missing.get(packageName) ?? [];
          files.push(toRepoPath(filePath));
          missing.set(packageName, files);
        }
      }

      expect(Object.fromEntries(missing)).toStrictEqual({});
      const allowedIndirect = INDIRECT_RUNTIME_DEPENDENCIES.get(extensionDir) ?? new Set<string>();
      const allowedComputed = COMPUTED_RUNTIME_DEPENDENCIES.get(extensionDir) ?? new Set<string>();
      const bundledIndirect = new Map(
        [...bundled.dependencies.values()].flatMap((dependency) =>
          Object.entries({ ...dependency.dependencies, ...dependency.optionalDependencies }),
        ),
      );
      const runtimeText = listRuntimeFiles(extensionDir)
        .map((filePath) => fs.readFileSync(path.resolve(REPO_ROOT, filePath), "utf8"))
        .concat(readManifestText(extensionDir))
        .join("\n");

      const unused = dependencyNames(manifest)
        .toSorted()
        .filter(
          (dependencyName) =>
            !allowedIndirect.has(dependencyName) &&
            !allowedComputed.has(dependencyName) &&
            bundledIndirect.get(dependencyName) !==
              (manifest.optionalDependencies?.[dependencyName] ??
                manifest.dependencies?.[dependencyName]) &&
            !runtimeText.includes(dependencyName),
        );

      expect(unused).toStrictEqual([]);
    });
  }
});
