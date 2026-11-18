import * as fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect } from "vitest";
import {
  buildPluginNpmRuntime,
  listMissingPluginNpmRuntimeHostExports,
  listPublishablePluginPackageDirs,
  resolvePluginNpmRuntimeBuildPlan,
  type PluginPackageJson,
} from "../scripts/lib/plugin-npm-runtime-build.mts";
import { resolveRuntimeWorkerThreadExecArgv } from "../src/infra/runtime-worker-url.js";
import { defineBundledChannelSetupEntry } from "../src/plugin-sdk/channel-entry-contract.js";
import { createCommandTest } from "./helpers/command-fixture.js";
import { writePublicRuntimeSurfacePluginFixture } from "./helpers/publishable-plugin-fixture.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const it = createCommandTest();

function writePackage(packageDir: string, metadata: PluginPackageJson = {}) {
  writeJsonFile(path.join(packageDir, "package.json"), {
    name: `@openclaw/${path.basename(packageDir)}`,
    version: "1.0.0",
    type: "module",
    ...metadata,
    openclaw: { extensions: ["./index.ts"], ...metadata.openclaw },
  });
}

function writeSources(packageDir: string, sources: Record<string, string>) {
  for (const [file, source] of Object.entries(sources)) {
    const target = path.join(packageDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
}

async function buildRuntime(packageDir: string, root = repoRoot, profile?: "qa-gateway-fixture") {
  return expectDefined(
    await buildPluginNpmRuntime({ repoRoot: root, packageDir, logLevel: "silent", profile }),
    "runtime build plan",
  );
}

function planRuntime(packageDir: string, root = repoRoot) {
  return expectDefined(
    resolvePluginNpmRuntimeBuildPlan({ repoRoot: root, packageDir }),
    "runtime build plan",
  );
}

function importRuntime(packageDir: string, entry: string) {
  return import(pathToFileURL(path.join(packageDir, entry)).href);
}

function readSource(packageDir: string, file: string) {
  return fs.readFileSync(path.join(packageDir, file), "utf8");
}

function copyPluginBuildFixture(plugin: string) {
  const source = path.join(repoRoot, "extensions", plugin);
  const packageDir = path.join(tempDirs.make("openclaw-plugin-runtime-package-"), plugin);
  // Source packages are also pnpm dependencies; never rebuild their shared dist during tests.
  fs.cpSync(source, packageDir, {
    recursive: true,
    filter: (file) => !["dist", "node_modules"].includes(path.basename(file)),
  });
  const nodeModules = path.join(source, "node_modules");
  if (fs.existsSync(nodeModules)) {
    fs.symlinkSync(nodeModules, path.join(packageDir, "node_modules"), "junction");
  }
  const tsconfig = path.join(source, "tsconfig.json");
  if (fs.existsSync(tsconfig)) {
    writeJsonFile(path.join(packageDir, "tsconfig.json"), { extends: tsconfig });
  }
  return packageDir;
}

it("loads the canonical Team Reports schema from the built package", async () => {
  const fixtureRoot = tempDirs.make("openclaw-plugin-runtime-schema-");
  const packageDir = path.join(fixtureRoot, "extensions", "team-reports");
  writeJsonFile(path.join(fixtureRoot, "package.json"), { exports: {} });
  writePackage(packageDir);
  writeSources(packageDir, {
    "index.ts":
      'export { TEAM_REPORTS_POSTGRES_SCHEMA_SQL } from "./src/store-postgres-schema.js";',
  });
  const sourceDir = path.join(packageDir, "src");
  fs.mkdirSync(sourceDir);
  for (const file of ["store-postgres-schema.ts", "team-reports-schema.postgres.sql"]) {
    fs.cpSync(path.join(repoRoot, "extensions/team-reports/src", file), path.join(sourceDir, file));
  }
  const plan = await buildRuntime(packageDir, fixtureRoot);
  const built = await importRuntime(packageDir, plan.runtimeExtensions[0]!);
  expect(built.TEAM_REPORTS_POSTGRES_SCHEMA_SQL).toBe(
    readSource(sourceDir, "team-reports-schema.postgres.sql"),
  );
});

it("keeps newer compatibility bindings out of frozen source roots that predate their files or exports", async () => {
  const frozenRoot = tempDirs.make("openclaw-plugin-runtime-frozen-root-");
  const packageDir = path.join(frozenRoot, "extensions", "frozen-fixture");
  writeJsonFile(path.join(frozenRoot, "package.json"), {
    exports: {
      "./plugin-sdk/channel-mention-gating": "./dist/plugin-sdk/channel-mention-gating.js",
      "./plugin-sdk/runtime-doctor-migrations": "./dist/plugin-sdk/runtime-doctor-migrations.js",
    },
  });
  writePackage(packageDir, { peerDependencies: { openclaw: "*" } });
  writeSources(packageDir, {
    "index.ts": [
      'export { normalizeChannelConfigEntries } from "openclaw/plugin-sdk/runtime-doctor-migrations";',
      'export { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-mention-gating";',
    ].join("\n"),
  });
  writeSources(frozenRoot, {
    "src/channels/mention-gating.ts":
      "export function resolveInboundMentionDecision() { return true; }\n",
  });
  const plan = await buildRuntime(packageDir, frozenRoot);
  const output = readSource(packageDir, plan.runtimeExtensions[0]!);
  for (const name of ["runtime-doctor-migrations", "channel-mention-gating"]) {
    expect(output).toContain(`openclaw/plugin-sdk/${name}`);
  }
});

it.for([
  ["esm", "@openclaw/telegram"],
  ["cjs", "@openclaw/telegram"],
  ["esm", "@openclaw/old-host-fixture"],
] as const)(
  "bundles compatible SDK operations while retaining host ownership (%s, %s)",
  ([runtimeFormat, packageName], { command }) =>
    command.lifetime.run(async () => {
      const packageDir = command.createTempDir("openclaw-plugin-runtime-old-host-");
      writePackage(packageDir, { name: packageName, openclaw: { build: { runtimeFormat } } });
      writeSources(packageDir, {
        "index.ts": [
          'export { createLegacyWebhookListenerDoctorContract, normalizeChannelConfigEntries } from "openclaw/plugin-sdk/runtime-doctor-migrations";',
          'export { classifyGatewayProbePath, resolvePluginRoutePathContext, isProtectedPluginRoutePathFromContext, resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";',
          'export { resolveBotThreadMentionPolicy, resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-mention-gating";',
          'export { createLivePreviewLifecycle, createPreviewMessageReceipt } from "openclaw/plugin-sdk/channel-outbound";',
          'export { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";',
        ].join("\n"),
      });
      const hostDir = path.join(packageDir, "node_modules", "openclaw");
      const hostBindings = {
        "runtime-doctor-migrations": "normalizeChannelConfigEntries",
        "gateway-config-runtime": "resolveGatewayPort",
        "channel-mention-gating": "resolveInboundMentionDecision",
        "channel-outbound": "createPreviewMessageReceipt",
        "error-runtime": "formatErrorMessage",
      };
      writeJsonFile(path.join(hostDir, "package.json"), {
        name: "openclaw",
        exports: Object.fromEntries(
          Object.keys(hostBindings).map((name) => [`./plugin-sdk/${name}`, `./${name}.cjs`]),
        ),
      });
      writeSources(hostDir, {
        ...Object.fromEntries(
          Object.entries(hostBindings).map(([name, binding]) => [
            `${name}.cjs`,
            `exports.${binding} = () => 31337;\n`,
          ]),
        ),
        "channel-outbound.cjs":
          "exports.createPreviewMessageReceipt = () => 31337;\n" +
          "exports.createLivePreviewLifecycle = () => ({ finalStarted: false });\n",
        "error-runtime.cjs":
          "let calls = 0; exports.formatErrorMessage = () => { calls++; return 'host-redacted'; };\n" +
          "exports.formatterCalls = () => calls;\n",
      });

      const plan = await buildRuntime(packageDir);
      // Published runtime proof must not inherit Vitest's source SDK aliases.
      const tsconfigPath = path.join(packageDir, "tsconfig.native.json");
      writeJsonFile(tsconfigPath, {});
      const loaded = await command.run(
        process.execPath,
        [
          ...(process.versions.bun ? ["--no-install", "--tsconfig-override", tsconfigPath] : []),
          "--eval",
          `const assert = require("node:assert/strict");
        const probeData = JSON.parse(process.argv[1]);
        (async () => {
          const symbols = new Set(Object.getOwnPropertySymbols(globalThis));
          const entry = await import(probeData.entry);
          const cfg = { channels: { telegram: { webhookPort: 8123 } } };
          const migrated = entry.createLegacyWebhookListenerDoctorContract({
            channelKey: "telegram", defaultPort: 8787,
          }).normalizeCompatibilityConfig({ cfg });
          if (probeData.packageName === "@openclaw/telegram") {
            const lifecycle = entry.createLivePreviewLifecycle();
            lifecycle.beginFinalDelivery();
            lifecycle.observeSuppression();
            assert.equal(lifecycle.finalSuppressed, true);
            lifecycle.reset();
            assert.equal(lifecycle.finalStarted, false);
            const accepted = entry.createLivePreviewLifecycle({
              onFinalStarted: () => { throw new Error("private fixture diagnostic"); },
            });
            await assert.rejects(
              accepted.observeDelivery({ visibleReplySent: true, messageIds: ["accepted"] }),
              ({ message, code, deliveryResult }) => {
                assert.deepEqual({ message, code, acceptedIds: deliveryResult.messageIds },
                  { message: "host-redacted", code: "CHANNEL_PARTIAL_DELIVERY", acceptedIds: ["accepted"] });
                return true;
              });
            assert.equal(accepted.finalSucceeded, true);
            assert.equal(require(probeData.hostDir + "/error-runtime.cjs").formatterCalls(), 1);
          } else {
            assert.equal(entry.createLivePreviewLifecycle,
              require(probeData.hostDir + "/channel-outbound.cjs").createLivePreviewLifecycle);
          }
          for (const [name, binding] of Object.entries(probeData.hostBindings)) {
            assert.equal(entry[binding], require(probeData.hostDir + "/" + name + ".cjs")[binding]);
          }
          assert.deepEqual(migrated.config, { channels: { telegram: { legacyWebhook: { port: 8123 } } } });
          assert.equal(cfg.channels.telegram.webhookPort, 8123);
          assert.equal(entry.classifyGatewayProbePath("/readyz"), "ready");
          assert.equal(entry.isProtectedPluginRoutePathFromContext(
            entry.resolvePluginRoutePathContext("/api/channels/telegram")), true);
          assert.equal(entry.resolveBotThreadMentionPolicy({
              isBotOwnedThread: true, requireMentionInBotThreads: false, requireMention: true,
            }).requireMention, false);
          assert.deepEqual(Object.getOwnPropertySymbols(globalThis)
            .filter((symbol) => !symbols.has(symbol)).map(String), []);
          console.log("runtime assertions passed");
        })().catch((error) => { throw error; });`,
          JSON.stringify({
            entry: pathToFileURL(path.join(packageDir, plan.runtimeExtensions[0]!)).href,
            hostDir,
            hostBindings,
            packageName,
          }),
        ],
        { cwd: packageDir, encoding: "utf8" },
      );
      expect(loaded, loaded.stderr).toMatchObject({ error: undefined, status: 0 });
      expect(loaded.stdout).toBe("runtime assertions passed\n");
    }),
);

it("packages declared theme definitions and artwork outside conventional asset paths", () => {
  const packageDir = tempDirs.make("openclaw-plugin-theme-package-");
  writePackage(packageDir, { name: "theme-fixture" });
  writeJsonFile(path.join(packageDir, "openclaw.plugin.json"), {
    id: "theme-fixture",
    themes: [
      {
        id: "workshop",
        name: "Workshop",
        description: "Workshop colors",
        source: "palettes/workshop.json",
        hats: { beret: "art/beret.svg" },
        critters: { ferris: { source: "visitors/ferris.svg", crossMs: 9000 } },
      },
    ],
  });
  const plan = planRuntime(packageDir);
  expect(plan.packageFiles).toEqual(
    expect.arrayContaining([
      "openclaw.plugin.json",
      "palettes/workshop.json",
      "art/beret.svg",
      "visitors/ferris.svg",
    ]),
  );
});

it.each(["missing-manifest", "malformed-manifest", "no-extensions", "javascript-only"])(
  "reports selected package input without touching output (%s)",
  async (scenario) => {
    const packageDir = path.join(tempDirs.make("openclaw-plugin-runtime-input-"), "selected");
    const manifestPath = path.join(packageDir, "package.json");
    const outDir = path.join(packageDir, "dist");
    writeSources(outDir, { "sentinel.js": "keep\n" });
    if (scenario === "malformed-manifest") {
      fs.writeFileSync(manifestPath, "{");
    } else if (scenario === "no-extensions" || scenario === "javascript-only") {
      writeJsonFile(manifestPath, {
        name: "input-fixture",
        version: "1.0.0",
        ...(scenario === "javascript-only" ? { openclaw: { extensions: ["./index.js"] } } : {}),
      });
      fs.writeFileSync(path.join(packageDir, "index.js"), "export default {};\n");
    }

    const result = buildPluginNpmRuntime({ repoRoot, packageDir, logLevel: "silent" });
    if (scenario === "missing-manifest") {
      await expect(result).rejects.toMatchObject({ code: "ENOENT", path: manifestPath });
    } else if (scenario === "malformed-manifest") {
      await expect(result).rejects.toBeInstanceOf(SyntaxError);
    } else {
      await expect(result).resolves.toBeNull();
    }
    expect(fs.readdirSync(outDir)).toEqual(["sentinel.js"]);
    expect(readSource(outDir, "sentinel.js")).toBe("keep\n");
  },
);

it.each(["qa-lab", "qa-channel"])(
  "builds an executable %s Gateway fixture without the tooling graph",
  async (id) => {
    const packageDir = path.join(tempDirs.make("openclaw-qa-gateway-package-"), id);
    writePackage(packageDir, {
      openclaw: { build: { workerEntries: ["./tooling.worker.ts"] } },
      private: true,
      version: "2026.9.5",
      dependencies: id === "qa-channel" ? { typebox: "1.3.32", zod: "4.6.5" } : {},
    });
    writeJsonFile(path.join(packageDir, "openclaw.plugin.json"), { id });
    const toolingImport = 'import "private-qa-tooling-not-installed";\n';
    const protocol = 'export { parseQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";\n';
    writeSources(packageDir, {
      "tooling-api.ts": toolingImport,
      "tooling.worker.ts": toolingImport,
      "index.ts": id === "qa-lab" ? toolingImport : 'export const companion = "./api.js";\n',
      [id === "qa-lab" ? "gateway-entry.ts" : "api.ts"]: protocol,
    });
    if (id === "qa-channel") {
      for (const file of ["setup-entry.ts", "setup-plugin-api.ts", "channel-plugin-api.ts"]) {
        writeSources(packageDir, { [file]: 'export const id = "qa-channel";\n' });
      }
    }

    const plan = await buildRuntime(packageDir, repoRoot, "qa-gateway-fixture");
    const runtimeEntry = expectDefined(
      plan.runtimeExtensions[0],
      "QA Gateway fixture runtime entry",
    );
    const entryUrl = pathToFileURL(path.join(packageDir, runtimeEntry));
    const entry = await import(entryUrl.href);
    const runtime =
      id === "qa-channel" ? await import(new URL(entry.companion, entryUrl).href) : entry;
    expect(runtime.parseQaTarget("thread:/v1/dm/Case%2FID/Thread")).toEqual({
      chatType: "direct",
      conversationId: "Case/ID",
      threadId: "Thread",
    });
    expect(listMissingPluginNpmRuntimeHostExports(plan)).toEqual([]);
  },
);

it("builds a private worker without registering it as a plugin entry", async () => {
  const packageDir = tempDirs.make("openclaw-plugin-runtime-worker-");
  writePackage(packageDir, {
    name: "@openclaw/worker-fixture",
    openclaw: {
      compat: { pluginApi: "1.0.0" },
      build: { workerEntries: ["./src/store.worker.ts"] },
    },
  });
  writeSources(packageDir, {
    "index.ts":
      `import { resolveRuntimeWorkerUrl } from ${JSON.stringify(path.join(repoRoot, "src/infra/runtime-worker-url.ts").replaceAll("\\", "/"))};
` +
      `export const workerUrl = resolveRuntimeWorkerUrl({
          currentModuleUrl: import.meta.url,
          sourceWorkerName: "store.worker",
          distWorkerPath: "extensions/worker-fixture/src/store.worker.js",
          package: { name: "@openclaw/worker-fixture", distWorkerPath: "src/store.worker.js" },
        });
`,
    "src/store.worker.ts":
      'import { parentPort, isMainThread } from "node:worker_threads";\n' +
      "const value: number = 42; parentPort!.postMessage({ value, isMainThread });\n",
  });

  const plan = await buildRuntime(packageDir);
  expect(plan.runtimeExtensions).toEqual(["./dist/index.js"]);
  const { workerUrl } = await importRuntime(packageDir, "dist/index.js");
  const worker = new Worker(workerUrl, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(workerUrl),
  });
  try {
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Worker exited before replying: ${code}`)));
    });
    expect(result).toEqual({ value: 42, isMainThread: false });
  } finally {
    await worker.terminate();
  }
});

it("builds an executable TSX package entry", async () => {
  const entry = "src/index.tsx";
  const packageDir = tempDirs.make("openclaw-plugin-runtime-tsx-");
  writePackage(packageDir, {
    name: "@openclaw/tsx-fixture",
    openclaw: { extensions: [`./${entry}`], compat: { pluginApi: "1.0.0" } },
  });
  writeSources(packageDir, {
    [entry]: 'const id: string = "tsx-fixture"; export default { id };\n',
  });
  await buildRuntime(packageDir);
  const output = path.join("dist", entry.replace(/\.tsx$/u, ".js"));
  expect((await importRuntime(packageDir, output)).default.id).toBe("tsx-fixture");
});

it("rejects a symlinked package dist root before building", async () => {
  const syntheticRepoRoot = tempDirs.make("openclaw-plugin-runtime-output-root-");
  const packageDir = path.join(syntheticRepoRoot, "extensions", "demo");
  writeJsonFile(path.join(syntheticRepoRoot, "package.json"), { version: "1.0.0" });
  writePackage(packageDir, {
    openclaw: { compat: { pluginApi: "1.0.0" }, release: { publishToNpm: true } },
  });
  fs.writeFileSync(path.join(packageDir, "index.ts"), "export default {};\n");
  const targetDir = path.join(syntheticRepoRoot, "live-gateway-dist");
  writeSources(targetDir, { "sentinel.js": "keep\n" });
  fs.symlinkSync(targetDir, path.join(packageDir, "dist"), "dir");

  await expect(buildRuntime(packageDir, syntheticRepoRoot)).rejects.toThrow(/symbolic link/u);
  expect(readSource(targetDir, "sentinel.js")).toBe("keep\n");
  expect(fs.readlinkSync(path.join(packageDir, "dist"))).toBe(targetDir);
});

it("plans package-local runtime entries for every publishable plugin package", () => {
  const packageDirs = listPublishablePluginPackageDirs({ repoRoot });
  expect(packageDirs.length).toBeGreaterThan(0);

  const resolvedPlans = packageDirs.map((packageDir) => planRuntime(packageDir));
  expect(resolvedPlans.map((plan) => plan.pluginDir)).toEqual(
    packageDirs.map((packageDir) => path.basename(packageDir)),
  );
});

it("includes top-level public runtime surfaces", () => {
  const fixtureRoot = tempDirs.make("openclaw-plugin-public-surfaces-");
  const { packageDir } = writePublicRuntimeSurfacePluginFixture(fixtureRoot);
  const plan = planRuntime(packageDir, fixtureRoot);
  expect(plan.entry).toEqual({
    api: path.join(packageDir, "api.ts"),
    index: path.join(packageDir, "index.ts"),
    "runtime-api": path.join(packageDir, "runtime-api.ts"),
  });
});

it("builds msteams startup runtime surfaces as CommonJS files", async () => {
  const plan = await buildRuntime(copyPluginBuildFixture("msteams"));
  expect(plan).toMatchObject({
    runtimeFormat: "cjs",
    runtimeExtensions: ["./dist/index.cjs"],
    runtimeSetupEntry: "./dist/setup-entry.cjs",
  });

  const setupEntryPath = path.join(plan.outDir, "setup-entry.cjs");
  const setupModule: { exports: Partial<ReturnType<typeof defineBundledChannelSetupEntry>> } = {
    exports: {},
  };
  const require = createRequire(import.meta.url);
  // Execute the emitted URL expressions and load companions through the host SDK;
  // hashed inventory chunks are private, while the setup entry remains stable.
  runInNewContext(fs.readFileSync(setupEntryPath, "utf8"), {
    __filename: setupEntryPath,
    __dirname: plan.outDir,
    module: setupModule,
    exports: setupModule.exports,
    URL,
    require: (specifier: string) =>
      specifier === "openclaw/plugin-sdk/channel-entry-contract"
        ? { defineBundledChannelSetupEntry }
        : require(specifier),
  });
  expect(setupModule.exports.kind).toBe("bundled-channel-setup-entry");
  expect(setupModule.exports.loadSetupPlugin?.()).toMatchObject({ id: "msteams" });
  expect(setupModule.exports.loadSetupSecrets?.()).toMatchObject({
    collectRuntimeConfigAssignments: expect.any(Function),
    secretTargetRegistryEntries: expect.any(Array),
  });
});

it.each([true, false])("checks emitted host imports only when present (%s)", (hasHostImports) => {
  const outDir = tempDirs.make("openclaw-plugin-runtime-host-import-");
  fs.writeFileSync(
    path.join(outDir, "index.js"),
    hasHostImports
      ? [
          'import "openclaw/plugin-sdk/not-exported";',
          'const runtime = __require("openclaw/plugin-sdk/not-exported-from-require");',
          "void runtime;",
          "",
        ].join("\n")
      : "export default {};\n",
  );
  const plan = planRuntime(path.join(repoRoot, "extensions", "codex"));
  expect(
    listMissingPluginNpmRuntimeHostExports({
      ...plan,
      repoRoot: hasHostImports
        ? repoRoot
        : tempDirs.make("openclaw-plugin-runtime-synthetic-repo-"),
      outDir,
    }),
  ).toEqual(
    hasHostImports
      ? ["openclaw/plugin-sdk/not-exported", "openclaw/plugin-sdk/not-exported-from-require"]
      : [],
  );
});
