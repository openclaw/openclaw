import fs from "node:fs";
import path from "node:path";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import { jsonSchemaValuesEqual } from "@openclaw/normalization-core/json-schema";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { root } from "../infra/fs-safe.js";
import { formatCwdRelativePathOrAbsolute as formatOutputPath } from "../infra/safe-cwd.js";
import { getToolPluginMetadata } from "../plugin-sdk/tool-plugin.js";
import { loadPluginControlUiDeclaration } from "../plugins/control-ui-build-manifest.js";
import {
  loadPluginManifest,
  PLUGIN_MANIFEST_FILENAME,
  resolvePackageExtensionEntries,
} from "../plugins/manifest.js";
import { unwrapDefaultModuleExport } from "../plugins/module-export.js";
import { controlUiSource } from "../plugins/package-manifest.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getCachedPluginModuleLoader } from "../plugins/plugin-module-loader-cache.js";
import { buildPluginLoaderAliasMap } from "../plugins/sdk-alias.js";
import { defaultRuntime } from "../runtime.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import { shortenHomeInString } from "../utils.js";
import { VERSION } from "../version.js";
import { formatCliOperatorError } from "./failure-output.js";
import { readPluginAuthoringJson as readJsonFile } from "./plugins-authoring-json.js";
import {
  buildToolPluginManifest,
  buildToolPluginPackageManifest,
  createConfigSchema,
  validateToolPluginProject,
} from "./plugins-authoring-metadata.js";
import { buildPluginControlUi, writePluginBuildManifest } from "./plugins-control-ui-build.js";
import { writeFeaturePluginScaffold } from "./plugins-feature-scaffold.js";

type JsonObject = Record<string, unknown>;

type PluginsBuildOptions = {
  root?: string;
  entry?: string;
  check?: boolean;
};

type PluginsValidateOptions = {
  root?: string;
  entry?: string;
  json?: boolean;
};

type PluginsValidationResult =
  | { valid: true; pluginId: string; errors: [] }
  | { valid: false; pluginId?: string; errors: string[] };

type PluginsInitOptions = {
  directory?: string;
  force?: boolean;
  name?: string;
  type?: string;
};

const SUPPORTED_PLUGIN_SCAFFOLD_TYPES = ["tool", "provider", "feature"] as const;
const CLAWHUB_PACKAGE_PUBLISH_WORKFLOW_REF = "9d49df109d4ad3dc8a6ecf05d26b39f46d294721";
const TOOL_PLUGIN_API_RANGE = ">=2026.5.17";

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeRelativePath(rootDir: string, targetPath: string): string {
  const relative = path
    .relative(rootDir, path.resolve(rootDir, targetPath))
    .replaceAll(path.sep, "/");
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error(`entry must stay inside plugin root: ${targetPath}`);
  }
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function resolveEntryPath(rootDir: string, entry: string | undefined): string {
  if (entry) {
    return path.resolve(rootDir, entry);
  }
  const packagePath = path.join(rootDir, "package.json");
  if (fs.existsSync(packagePath)) {
    const extensionResolution = resolvePackageExtensionEntries(readJsonFile(packagePath));
    if (extensionResolution.status === "ok" && extensionResolution.entries[0]) {
      return path.resolve(rootDir, extensionResolution.entries[0]);
    }
  }
  return path.resolve(rootDir, "src/index.ts");
}

function readPackageManifest(rootDir: string): JsonObject {
  const packagePath = path.join(rootDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error(`package.json not found: ${packagePath}`);
  }
  return readJsonFile(packagePath);
}

export async function loadToolPlugin(params: { rootDir: string; entryPath: string }) {
  // Tool and feature helpers publish the same static authoring metadata.
  if (!fs.existsSync(params.entryPath)) {
    throw new Error(
      `plugin entry not found: ${normalizeRelativePath(params.rootDir, params.entryPath)}`,
    );
  }
  const loader = getCachedPluginModuleLoader({
    modulePath: params.entryPath,
    importerUrl: import.meta.url,
    loaderFilename: params.entryPath,
    aliasMap: buildPluginLoaderAliasMap(params.entryPath, process.argv[1], import.meta.url),
  });
  const loaded = loader(toSafeImportPath(params.entryPath));
  const mod =
    loaded && typeof loaded === "object"
      ? (loaded as { default?: unknown; createEntry?: unknown; entry?: unknown })
      : undefined;
  const candidate = unwrapDefaultModuleExport(
    mod?.default ?? mod?.createEntry ?? mod?.entry ?? loaded,
  );
  const entry = await (typeof candidate === "function"
    ? (candidate as () => unknown)()
    : candidate);
  const metadata = getToolPluginMetadata(entry);
  if (!metadata) {
    throw new Error(
      `plugin entry does not expose tool or feature authoring metadata: ${normalizeRelativePath(
        params.rootDir,
        params.entryPath,
      )}`,
    );
  }
  return { entry, metadata };
}

export async function runPluginsBuildCommand(opts: PluginsBuildOptions): Promise<void> {
  const rootDir = path.resolve(opts.root ?? process.cwd());
  const entryPath = resolveEntryPath(rootDir, opts.entry);
  const entryRelative = normalizeRelativePath(rootDir, entryPath);
  const packagePath = path.join(rootDir, "package.json");
  const packageManifest = readPackageManifest(rootDir);
  const { metadata } = await loadToolPlugin({ rootDir, entryPath });
  const manifestPath = path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
  const currentManifest = fs.existsSync(manifestPath) ? readJsonFile(manifestPath) : undefined;
  const manifest = buildToolPluginManifest({
    metadata,
    packageManifest,
    existingManifest: currentManifest,
  });
  const browserSource = controlUiSource(packageManifest);
  if (browserSource) {
    manifest.controlUi = await buildPluginControlUi({
      rootDir,
      source: browserSource,
      check: opts.check,
    });
  }
  const nextPackageManifest = buildToolPluginPackageManifest({
    packageManifest,
    entry: entryRelative,
  });

  if (opts.check) {
    const currentPackage = readJsonFile(packagePath);
    const currentControlUi = withPluginCache(createPluginCache(), () =>
      loadPluginControlUiDeclaration({
        rootDir,
        controlUi: currentManifest?.controlUi,
        channels: currentManifest?.channels,
        rejectHardlinks: false,
      }),
    );
    if (
      (browserSource &&
        (!currentControlUi.ok ||
          !jsonSchemaValuesEqual(currentControlUi.value, manifest.controlUi))) ||
      !jsonSchemaValuesEqual(currentManifest, manifest) ||
      !jsonSchemaValuesEqual(currentPackage, nextPackageManifest)
    ) {
      defaultRuntime.error("Generated plugin metadata is out of date. Run openclaw plugins build.");
      return defaultRuntime.exit(1);
    }
    defaultRuntime.log("Plugin metadata is up to date.");
    return;
  }

  const realRootDir = fs.realpathSync(rootDir);
  await replaceFileAtomic({
    filePath: path.join(realRootDir, "package.json"),
    content: `${JSON.stringify(nextPackageManifest, null, 2)}\n`,
    preserveExistingMode: true,
    dirMode: "preserve",
    syncTempFile: true,
    syncParentDir: true,
  });
  // Retire the derived pointer before publishing the authored declaration;
  // failed retirement must leave the previous authored pointer and assets usable.
  if (browserSource) {
    await (
      await root(realRootDir, { symlinks: "reject" })
    ).remove(`dist/${PLUGIN_MANIFEST_FILENAME}`, { force: true });
  }
  await writePluginBuildManifest(realRootDir, manifest);
  defaultRuntime.log(
    terminalText`Wrote ${formatOutputPath(manifestPath, PLUGIN_MANIFEST_FILENAME)}`,
  );
  defaultRuntime.log(terminalText`Updated ${formatOutputPath(packagePath, "package.json")}`);
}

export async function collectPluginsValidationResult(
  opts: PluginsValidateOptions,
): Promise<PluginsValidationResult> {
  const rootDir = path.resolve(opts.root ?? process.cwd());
  const entryPath = resolveEntryPath(rootDir, opts.entry);
  const entryRelative = normalizeRelativePath(rootDir, entryPath);
  const packageManifest = readPackageManifest(rootDir);
  const manifestResult = withPluginCache(createPluginCache(), () =>
    loadPluginManifest(rootDir, false),
  );
  if (!manifestResult.ok) {
    return { valid: false, errors: [manifestResult.error] };
  }
  const manifest = readJsonFile(path.join(rootDir, PLUGIN_MANIFEST_FILENAME));
  const { metadata } = await loadToolPlugin({ rootDir, entryPath });
  const errors = validateToolPluginProject({
    metadata,
    manifest,
    packageManifest,
    entry: entryRelative,
  });
  const browserSource = controlUiSource(packageManifest);
  if (browserSource) {
    const declaration = await buildPluginControlUi({ rootDir, source: browserSource, check: true });
    if (
      !jsonSchemaValuesEqual(manifest.controlUi, declaration) ||
      !jsonSchemaValuesEqual(manifestResult.manifest.controlUi, declaration)
    ) {
      errors.push("Control UI manifest is stale. Run openclaw plugins build.");
    }
  }
  if (errors.length > 0) {
    return { valid: false, pluginId: metadata.id, errors };
  }

  return { valid: true, pluginId: metadata.id, errors: [] };
}

export async function runPluginsValidateCommand(opts: PluginsValidateOptions): Promise<void> {
  let result: PluginsValidationResult;
  try {
    result = await collectPluginsValidationResult(opts);
  } catch (err) {
    if (!opts.json) {
      throw err;
    }
    const failure = err instanceof Error ? err : String(err);
    result = { valid: false, errors: [formatCliOperatorError(failure)] };
  }

  if (!result.valid) {
    for (const error of result.errors) {
      defaultRuntime.error(terminalText`${error}`);
    }
    if (opts.json) {
      defaultRuntime.writeJson({
        ...result,
        errors: result.errors.map(shortenHomeInString),
      });
    }
    return defaultRuntime.exit(1, opts.json ? { resetStream: process.stderr } : undefined);
  }
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(terminalText`Plugin ${result.pluginId} is valid.`);
}

function normalizeRequiredPluginText(input: string, label: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error(`Plugin ${label} is required.`);
  }
  return value;
}

const createPluginPackageMetadata = (pluginApi: string) => ({
  extensions: ["./dist/index.js"],
  compat: { pluginApi },
  build: { openclawVersion: VERSION },
});

export async function runPluginsInitCommand(
  idInput: string,
  opts: PluginsInitOptions,
): Promise<void> {
  const id = normalizeRequiredPluginText(idInput, "id");
  const name = opts.name
    ? normalizeRequiredPluginText(opts.name, "display name")
    : id
        .split(/[-_]/u)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  const requestedType = opts.type ?? "tool";
  const type = SUPPORTED_PLUGIN_SCAFFOLD_TYPES.find((candidate) => candidate === requestedType);
  if (!type) {
    throw new Error(
      `Unsupported plugin scaffold type "${requestedType}". Supported types: ${SUPPORTED_PLUGIN_SCAFFOLD_TYPES.join(
        ", ",
      )}.`,
    );
  }
  const packageName = id.startsWith("@")
    ? id.replace("/", "/openclaw-plugin-")
    : `openclaw-plugin-${id}`;
  const rootDir = path.resolve(opts.directory ?? id);
  if (opts.force !== true && fs.existsSync(rootDir)) {
    throw new Error(`Refusing to overwrite existing path: ${rootDir}`);
  }
  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });

  if (type === "feature") {
    writeFeaturePluginScaffold({ rootDir, id, name });
  } else if (type === "provider") {
    const envVar = `${id
      .replace(/[^a-z0-9]+/giu, "_")
      .replace(/^_+|_+$/gu, "")
      .toUpperCase()}_API_KEY`;
    const parts = id.split(/-+/u).filter(Boolean);
    const optionKey = `${parts
      .map((part, index) =>
        index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
      )
      .join("")}ApiKey`;
    const flagName = `--${id}-api-key`;
    const defaultModelId = "example-chat";
    const defaultModelRef = `${id}/${defaultModelId}`;
    const description = `Add ${name} models to OpenClaw.`;
    const packageManifest = {
      name: packageName,
      version: "0.1.0",
      description: `OpenClaw provider plugin for ${name}.`,
      type: "module",
      scripts: {
        build: "tsc -p tsconfig.json",
        test: "vitest run --config ./vitest.config.ts",
        validate: "npm run build && clawhub package validate . --out .clawhub-validation",
      },
      files: ["dist", "openclaw.plugin.json", "README.md"],
      peerDependencies: {
        openclaw: `>=${VERSION}`,
      },
      peerDependenciesMeta: {
        openclaw: {
          optional: true,
        },
      },
      devDependencies: {
        clawhub: "latest",
        openclaw: "latest",
        typescript: "7.0.2",
        vitest: "^3.2.0",
      },
      openclaw: {
        ...createPluginPackageMetadata(`>=${VERSION}`),
        install: {
          clawhubSpec: `clawhub:${packageName}`,
          defaultChoice: "clawhub",
          minHostVersion: `>=${VERSION}`,
        },
        release: {
          publishToClawHub: true,
        },
      },
      pluginInspector: {
        version: 1,
        plugin: {
          id,
          priority: "high",
          seams: ["plugin-runtime"],
          sourceRoot: ".",
          expect: {
            registrations: ["registerProvider"],
          },
        },
      },
    };
    const idLiteral = JSON.stringify(id);
    const nameLiteral = JSON.stringify(name);
    const envVarLiteral = JSON.stringify(envVar);
    const defaultModelIdLiteral = JSON.stringify(defaultModelId);
    const defaultModelRefLiteral = JSON.stringify(defaultModelRef);
    const indexSource = `import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";

const PLUGIN_ID = ${idLiteral};
const PROVIDER_ID = PLUGIN_ID;
const DEFAULT_MODEL_ID = ${defaultModelIdLiteral};
const DEFAULT_MODEL_REF = ${defaultModelRefLiteral};

export default definePluginEntry({
  id: PLUGIN_ID,
  name: ${nameLiteral},
  description: ${JSON.stringify(description)},
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: ${nameLiteral},
      docsPath: "/providers/${id}",
      envVars: [${envVarLiteral}],
      auth: [
        createProviderApiKeyAuthMethod({
          providerId: PROVIDER_ID,
          methodId: "api-key",
          label: ${JSON.stringify(`${name} API key`)},
          hint: "OpenAI-compatible API endpoint",
          optionKey: ${JSON.stringify(optionKey)},
          flagName: ${JSON.stringify(flagName)},
          envVar: ${envVarLiteral},
          promptMessage: ${JSON.stringify(`Enter ${name} API key`)},
          defaultModel: DEFAULT_MODEL_REF,
          expectedProviders: [PROVIDER_ID],
          noteTitle: ${nameLiteral},
          noteMessage: ${JSON.stringify(`Replace https://api.example.com/v1 with your ${name} API base URL.`)},
        }),
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (!apiKey) {
            return null;
          }
          const configuredProvider = Object.entries(ctx.config.models?.providers ?? {}).find(
            ([providerId]) => providerId.trim().toLowerCase() === PROVIDER_ID.toLowerCase(),
          )?.[1];
          return {
            provider: {
              api: "openai-completions",
              models: [
                {
                  id: DEFAULT_MODEL_ID,
                  name: "Example Chat",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 128000,
                  maxTokens: 8192,
                },
              ],
              apiKey,
              baseUrl: configuredProvider?.baseUrl?.trim() || "https://api.example.com/v1",
            },
          };
        },
      },
    });
  },
});
`;
    const testSource = `import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";

describe(${idLiteral}, () => {
  it("registers the provider and resolves its authenticated catalog", async () => {
    const providers: ProviderPlugin[] = [];
    const api = {
      registerProvider(provider: ProviderPlugin) {
        providers.push(provider);
      },
    } as Partial<OpenClawPluginApi>;

    entry.register(api as OpenClawPluginApi);

    expect(providers.map((provider) => provider.id)).toEqual([${idLiteral}]);
    expect(providers[0]?.label).toBe(${nameLiteral});
    expect(providers[0]?.envVars).toEqual([${envVarLiteral}]);

    const provider = providers[0];
    if (!provider?.catalog) {
      throw new Error("Generated provider did not register its catalog");
    }
    expect(provider.auth).toMatchObject([
      { id: "api-key", kind: "api_key", starterModel: ${defaultModelRefLiteral} },
    ]);
    for (const [apiKey, configuredId, baseUrl, expectedBaseUrl] of [
      [undefined, ${idLiteral}, "https://configured.example/v1", null],
      ["fixture-api-key", ${JSON.stringify(`${id}-unrelated`)}, "https://unrelated.example/v1", "https://api.example.com/v1"],
      ["fixture-api-key", ${JSON.stringify(` ${id.toUpperCase()} `)}, " https://configured.example/v1 ", "https://configured.example/v1"],
      ["fixture-api-key", ${idLiteral}, " ", "https://api.example.com/v1"],
    ] as const) {
      const result = await provider.catalog.run({
        config: { models: { providers: { [configuredId]: { baseUrl, models: [] } } } },
        env: {},
        resolveProviderApiKey: () => ({ apiKey }),
        resolveProviderAuth: () => ({ apiKey, mode: "api_key", source: "env" }),
      });
      expect(result).toEqual(
        expectedBaseUrl === null
          ? null
          : {
              provider: {
                api: "openai-completions",
                apiKey,
                baseUrl: expectedBaseUrl,
                models: [{
                  id: ${defaultModelIdLiteral},
                  name: "Example Chat",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 8192,
                }],
              },
            },
      );
    }
  });
});
`;
    const readmeSource = `# ${name}

OpenClaw provider plugin for ${name}.

## Commands

\`\`\`bash
npm install
npm run build
npm test
npm run validate
\`\`\`

\`npm run validate\` builds the plugin and runs \`clawhub package validate . --out .clawhub-validation\`.

## Provider Setup

The generated provider uses an OpenAI-compatible API shape, \`${envVar}\` for API-key auth, and \`https://api.example.com/v1\` as a placeholder base URL. Update \`src/index.ts\` with your provider's real base URL, model list, docs route, and credential copy before publishing.

## First Publish

Install dependencies, log in to the ClawHub CLI, then validate and publish manually once:

\`\`\`bash
npm install
npm exec clawhub -- login
npm run validate
npm exec clawhub -- package publish .
\`\`\`

That first publish creates the ClawHub package and establishes the package managers who can configure trusted publishing.

## Trusted Publishing

After the first publish, configure GitHub Actions OIDC publishing for future releases:

\`\`\`bash
npm exec clawhub -- package trusted-publisher set ${packageName} \\
  --repository <owner>/<repo> \\
  --workflow-filename clawhub-publish.yml
\`\`\`

Future release publishes can run through the manually dispatched \`.github/workflows/clawhub-publish.yml\` action without a long-lived ClawHub token. Run it first with \`dry_run=true\`, then rerun with \`dry_run=false\` after the preview is clean.
`;
    const workflowSource = `name: ClawHub Publish

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: Preview without publishing
        required: true
        type: boolean
        default: true

jobs:
  publish:
    permissions:
      actions: read
      contents: read
      id-token: write
    uses: openclaw/clawhub/.github/workflows/package-publish.yml@${CLAWHUB_PACKAGE_PUBLISH_WORKFLOW_REF}
    with:
      dry_run: \${{ inputs.dry_run }}
`;

    writeJsonFile(path.join(rootDir, "package.json"), packageManifest);
    fs.writeFileSync(path.join(rootDir, "src/index.ts"), indexSource);
    fs.writeFileSync(path.join(rootDir, "src/index.test.ts"), testSource);
    fs.writeFileSync(path.join(rootDir, "README.md"), readmeSource);
    fs.mkdirSync(path.join(rootDir, ".github/workflows"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, ".github/workflows/clawhub-publish.yml"), workflowSource);
    writeJsonFile(path.join(rootDir, PLUGIN_MANIFEST_FILENAME), {
      id,
      name,
      description,
      version: packageManifest.version,
      providers: [id],
      setup: {
        providers: [
          {
            id,
            envVars: [envVar],
          },
        ],
      },
      configSchema: createConfigSchema(),
      activation: { onStartup: true, providers: [id], capabilities: ["provider"] },
    });
  } else {
    const packageManifest = {
      name: packageName,
      version: "0.1.0",
      type: "module",
      private: true,
      scripts: {
        build: "tsc -p tsconfig.json",
        "plugin:build": "npm run build && openclaw plugins build --entry ./dist/index.js",
        "plugin:validate": "npm run build && openclaw plugins validate --entry ./dist/index.js",
        test: "vitest run --config ./vitest.config.ts",
      },
      files: ["dist", "openclaw.plugin.json", "README.md"],
      peerDependencies: {
        openclaw: TOOL_PLUGIN_API_RANGE,
      },
      dependencies: {
        typebox: "^1.1.38",
      },
      devDependencies: {
        openclaw: "latest",
        typescript: "7.0.2",
        vitest: "^3.2.0",
      },
      openclaw: createPluginPackageMetadata(TOOL_PLUGIN_API_RANGE),
    };
    const idLiteral = JSON.stringify(id);
    const description = `Add ${name} tools to OpenClaw.`;
    const indexSource = `import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

export default defineToolPlugin({
  id: ${idLiteral},
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  tools: (tool) => [
    tool({
      name: "echo",
      description: "Echo input text.",
      parameters: Type.Object({
        input: Type.String({ description: "Text to echo." }),
      }),
      execute: async ({ input }) => ({ input }),
    }),
  ],
});
`;
    const testSource = `import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe(${idLiteral}, () => {
  it("declares tool metadata", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((tool) => tool.name)).toEqual(["echo"]);
  });
});
`;
    const readmeSource = `# ${name}

Simple OpenClaw tool plugin.

## Build

\`\`\`bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
\`\`\`
`;

    writeJsonFile(path.join(rootDir, "package.json"), packageManifest);
    fs.writeFileSync(path.join(rootDir, "src/index.ts"), indexSource);
    fs.writeFileSync(path.join(rootDir, "src/index.test.ts"), testSource);
    fs.writeFileSync(path.join(rootDir, "README.md"), readmeSource);
    writeJsonFile(path.join(rootDir, PLUGIN_MANIFEST_FILENAME), {
      id,
      name,
      description,
      version: packageManifest.version,
      configSchema: createConfigSchema(),
      activation: { onStartup: true },
      contracts: { tools: ["echo"] },
    });
  }
  writeJsonFile(path.join(rootDir, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      declaration: type === "tool",
      rootDir: "src",
      outDir: "dist",
      skipLibCheck: true,
    },
    include: type === "feature" ? ["src/**/*.ts"] : ["src/index.ts"],
  });
  if (type !== "feature") {
    fs.writeFileSync(
      path.join(rootDir, "vitest.config.ts"),
      `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
`,
    );
  }
  defaultRuntime.log(terminalText`Created ${formatOutputPath(rootDir, ".")}`);
}
