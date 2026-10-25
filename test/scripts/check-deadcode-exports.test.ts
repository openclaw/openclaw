import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectRuntimeProcessManifestEntries,
  compileDynamicConsumerEdges,
} from "../../config/knip-dynamic-consumers.mjs";
import allExportsKnipConfig from "../../config/knip.all-exports.config.ts";
import knipConfig from "../../config/knip.config.ts";
import scriptExportsKnipConfig from "../../config/knip.scripts-exports.config.ts";
import {
  checkExportScan,
  parseKnipCompactUnusedExportsResult,
} from "../../scripts/check-deadcode-exports.mts";
import { readUpdateCompatibilityInventory } from "../../scripts/lib/update-compat-chunks.mts";
import { vitestWorkerBuildEntries } from "../../scripts/lib/vitest-worker-build-entries.mts";
import { vitestWorkerDeclarationEntries } from "../../scripts/lib/vitest-worker-declarations.mts";
import {
  runtimeProcessScriptEntrypoints,
  runtimeProcessToolingEntrypoints,
} from "../../src/infra/runtime-process-manifest.ts";

const fullRootWorkspace = allExportsKnipConfig.workspaces["."];
const fullExtensionWorkspace = allExportsKnipConfig.workspaces["extensions/*"];
const fullUiWorkspace = allExportsKnipConfig.workspaces.ui;
const scriptRootWorkspace = scriptExportsKnipConfig.workspaces["."];
if (!fullRootWorkspace || !fullExtensionWorkspace || !fullUiWorkspace || !scriptRootWorkspace) {
  throw new Error("deadcode Knip configs must define root, extension, and UI workspaces");
}

function expectEntries(entries: readonly string[], required: string[]) {
  expect(entries).toEqual(expect.arrayContaining(required));
}
function replaceFixture(source: string, from: string, to: string) {
  expect(source).toContain(from);
  const replaced = source.replace(from, to);
  expect(replaced).not.toBe(source);
  return replaced;
}
const isEntry = (entries: readonly string[], file: string) =>
  entries.some((entry) => path.matchesGlob(file, entry.replace(/!$/u, "")));
afterEach(() => vi.restoreAllMocks());

describe("check-deadcode-exports", () => {
  it("models the PostgreSQL broker fixture only when both consumers exist", () => {
    const compile = knipConfig.compilers.mjs;
    const filePath = "config/knip-dynamic-consumers.mjs";
    expect(compile("// dynamic consumers", filePath)).toContain(
      'import { createSqliteWorkerBackend as __dynamicPgPool_0 } from "../scripts/perf/pg-pool-broker.fixture.mts";',
    );

    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const source = readFileSync(file, options);
      return path.resolve(String(file)) === path.resolve("scripts/perf/pg-pool-lifecycle.mts")
        ? String(source).replace('moduleUrl: new URL("./pg-pool-broker.fixture.mts", self),', "")
        : source;
    });
    expect(compile("// dynamic consumers", filePath)).not.toContain("pg-pool-broker.fixture.mts");

    vi.mocked(fs.readFileSync).mockImplementation((file, options) => {
      const source = readFileSync(file, options);
      return path.resolve(String(file)) === path.resolve("src/infra/sqlite-store.worker.ts")
        ? String(source).replace('"createSqliteWorkerBackend"', '""')
        : source;
    });
    expect(compile("// dynamic consumers", filePath)).not.toContain("pg-pool-broker.fixture.mts");
  });

  it("makes tests in every workspace roots of the full-tree export audit", () => {
    expectEntries(knipConfig.workspaces["."].entry, [
      "config/knip.config.ts!",
      "config/knip.all-exports.config.ts!",
      "config/knip.scripts-exports.config.ts!",
      "scripts/generate-runtime-script-assets.mjs!",
      "scripts/generate-static-validators.mts!",
      "scripts/perf/cron-delivery-gateway-entry.ts!",
      "scripts/perf/plugin-policy-read-measure.mjs!",
      "scripts/perf/prompt-cache-observation-measure.ts!",
      "scripts/perf/reconnect-read-wave-measure.ts!",
      "scripts/perf/session-actor-retention-measure.ts!",
      "scripts/perf/session-row-churn-probe.ts!",
      "tsdown.config.ts!",
    ]);
    expect(knipConfig.workspaces["."].project).toContain("config/**/*.{ts,mts,cts}!");
    expectEntries(fullRootWorkspace.entry, [
      "test/vitest/vitest*.config.ts!",
      "scripts/crabbox-wrapper.mjs!",
      "scripts/crabbox-wrapper.mts!",
      "scripts/check-openclaw-package-tarball.mjs!",
      "scripts/check-openclaw-package-tarball.mts!",
      "test/scripts/service-relay-artifact.test-support.mjs!",
    ]);
    expect(knipConfig.workspaces["."].entry).not.toContain(
      "test/scripts/service-relay-artifact.test-support.mjs!",
    );
    for (const extension of ["js", "mjs", "cjs", "ts", "tsx", "mts", "cts"]) {
      for (const directory of ["src", "scripts", "test"]) {
        expect(isEntry(fullRootWorkspace.entry, `${directory}/x.test.${extension}`)).toBe(true);
      }
      expect(isEntry(fullExtensionWorkspace.entry, `src/example.spec.${extension}`)).toBe(true);
      expect(isEntry(fullUiWorkspace.entry, `src/example.test.${extension}`)).toBe(true);
      expect(isEntry(knipConfig.workspaces["."].entry, `test/x.test.${extension}`)).toBe(false);
    }
    expect(isEntry(fullRootWorkspace.entry, ".agents/skills/example/scripts/probe.ts")).toBe(true);
  });

  it("models both compiled subprocess registries as workspace-relative full-tree roots", () => {
    const buildSources = Object.values(vitestWorkerBuildEntries).map((source) =>
      path.relative(".", source).replaceAll("\\", "/"),
    );
    const declarationSources = Object.values(vitestWorkerDeclarationEntries);
    for (const [workspace, settings] of Object.entries(allExportsKnipConfig.workspaces)) {
      expect(
        settings.entry.filter((entry) => entry.replaceAll("\\", "/").startsWith("../")),
        workspace,
      ).toEqual([]);
      const prefix = workspace === "." ? "" : `${workspace}/`;
      for (const source of [...buildSources, ...declarationSources]) {
        if (source.startsWith(prefix)) {
          expect(settings.entry, `${workspace}: ${source}`).toContain(
            `${source.slice(prefix.length)}!`,
          );
        }
      }
    }

    expect(allExportsKnipConfig.workspaces["extensions/qa-lab"]?.entry).toContain(
      "src/gateway-child-artifacts-runtime.test-support.ts!",
    );
  });

  it("derives generated script and tooling roots from the runtime manifest", () => {
    expectEntries(knipConfig.workspaces["."].entry, [
      "scripts/generate-kysely-types.mts!",
      "scripts/generate-npm-package-lock.worker.mts!",
      "scripts/lib/fs-safe-npm-cli-preload.entry.mjs!",
      "scripts/lib/package-cli-node-probe.entry.mjs!",
      "scripts/lib/package-cli-node-probe.generated.mjs!",
      "scripts/lib/test-selector-source-facts.worker.mts!",
      "src/infra/daemon-runtime-probe.entry.ts!",
      "src/infra/node-runtime-probe.entry.ts!",
    ]);
    expect(knipConfig.workspaces["."].entry).not.toContain(
      "src/gateway/worker-environments/workspace-quiescence-scripts.ts!",
    );
    expect(knipConfig.workspaces["."].entry).not.toContain(
      "src/infra/update-managed-service-handoff.ts!",
    );

    const { packageCliNodeProbe: _packageCliNodeProbe, ...withoutPackageCliNodeProbe } =
      runtimeProcessScriptEntrypoints;
    const withoutScriptDeclaration = collectRuntimeProcessManifestEntries(
      withoutPackageCliNodeProbe,
      runtimeProcessToolingEntrypoints,
    );
    expect(withoutScriptDeclaration).not.toContain("scripts/lib/package-cli-node-probe.entry.mjs");
    expect(withoutScriptDeclaration).not.toContain(
      "scripts/lib/package-cli-node-probe.generated.mjs",
    );
    expect(withoutScriptDeclaration).toContain("src/infra/node-runtime-probe.entry.ts");
    const withoutGeneratedBinding = compileDynamicConsumerEdges(
      "// dynamic consumers",
      "config/knip-dynamic-consumers.mjs",
      withoutPackageCliNodeProbe,
    );
    expect(withoutGeneratedBinding).not.toContain("PACKAGE_CLI_NODE_PROBE_SOURCE");
    expect(withoutGeneratedBinding).toContain("NODE_RUNTIME_PROBE_SOURCE");

    const { npmPackageLock: _npmPackageLock, ...withoutNpmPackageLock } =
      runtimeProcessToolingEntrypoints;
    const withoutToolingDeclaration = collectRuntimeProcessManifestEntries(
      runtimeProcessScriptEntrypoints,
      withoutNpmPackageLock,
    );
    expect(withoutToolingDeclaration).not.toContain("scripts/generate-npm-package-lock.worker.mts");
    expect(withoutToolingDeclaration).toContain(
      "scripts/lib/test-selector-source-facts.worker.mts",
    );
  });

  it("keeps the script unused-export scan scoped to real executable roots", () => {
    expectEntries(
      scriptRootWorkspace.entry,
      `.agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!
.github/actions/setup-node-env/dependency-fingerprint.mjs! apps/android/scripts/build-release-artifacts.ts!
security/opengrep/check-rule-metadata.mjs! skills/meme-maker/scripts/meme.mjs!
scripts/check-openclaw-package-tarball.mts! scripts/crabbox-wrapper.mjs! scripts/crabbox-wrapper.mts!
scripts/lib/vitest-resource-reporter.mts! scripts/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!
test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}! src/plugin-sdk/api-baseline.ts!`.split(/\s+/u),
    );
    expect(scriptRootWorkspace.entry).not.toContain("scripts/**/*.{js,mjs,cjs,ts,mts,cts}!");
    const sourceTestConsumers = [
      "src/scripts/docs-link-audit.test.ts!",
      "src/scripts/ci-changed-scope.contract-fixtures.test.ts!",
      "src/scripts/ci-changed-scope.control-ui.test.ts!",
      "src/scripts/ci-changed-scope.git-owner.test.ts!",
      "src/scripts/ci-changed-scope.native-i18n.test.ts!",
      "src/scripts/ci-changed-scope.test.ts!",
      "src/scripts/ci-changed-scope.windows.test.ts!",
      "src/scripts/ci-ios-screenshot-scope.test.ts!",
      "src/plugins/prune-docker-plugin-dist.test.ts!",
      "src/infra/package-update-activation-lifetime.test.ts!",
    ];
    expectEntries(scriptRootWorkspace.entry, sourceTestConsumers);
    expectEntries(scriptRootWorkspace.project, sourceTestConsumers);
    expect(scriptRootWorkspace.entry).not.toContain("src/**/*.test.ts!");
    expect(
      scriptExportsKnipConfig.ignoreIssues["scripts/lib/vitest-resource-reporter.mts"],
    ).toEqual(["exports"]);
    expect(scriptExportsKnipConfig.ignoreIssues).toHaveProperty("src/**");
    expect(scriptExportsKnipConfig.ignoreIssues).toHaveProperty(
      "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
    );
    expect(scriptRootWorkspace.vitest).toEqual({
      config: [
        "scripts/control-ui-parity/vitest.config.ts",
        "scripts/control-ui-retention/vitest.config.ts",
      ],
    });
    expect(knipConfig.workspaces["."].vitest).toEqual({
      config: [
        "vitest.config.{js,mjs,ts,cjs,mts,cts}",
        "vitest.{workspace,projects}.{js,mjs,ts,cjs,mts,cts,json}",
        "scripts/control-ui-parity/vitest.config.ts",
        "scripts/control-ui-retention/vitest.config.ts",
      ],
    });
  });

  it.each([
    ["sh", "scripts/e2e/lib/upgrade-survivor/run.sh", "readPostCoreSnapshot", "./diagnostics.mjs"],
    [
      "yml",
      ".github/workflows/openclaw-release-publish.yml",
      "prefetchPreparedPlugins",
      "../../scripts/openclaw-release-ready.mjs",
    ],
  ] as const)("models %s inline imports from %s", (kind, file, symbol, importedFrom) => {
    const source = fs.readFileSync(file, "utf8");
    const compile = knipConfig.compilers[kind];
    for (const workspace of [knipConfig.workspaces["."], fullRootWorkspace, scriptRootWorkspace]) {
      expect(workspace.entry).toContain(`${file}!`);
    }
    expect(compile(source, file)).toContain(`import { ${symbol} } from "${importedFrom}";`);
    const remaining = compile(
      source.replace(new RegExp(`^\\s*import \\{ ${symbol} \\}[^\\n]+\\n`, "mu"), ""),
      file,
    );
    expect(remaining).not.toContain(symbol);
    if (kind === "sh") {
      expect(remaining).toContain('from "../../../lib/release-version.mjs";');
    }
    expect(compile(source, path.join(path.dirname(file), `other.${kind}`))).toBe("");
  });

  it("models named Solid lazy consumers without retaining a deleted loader", () => {
    const source = `const SettingsSidebar = lazy(() => import("./settings-sidebar-shell.tsx"), {
  export: "ShellSettingsSidebar",
});`;
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue(source);
    const compile = knipConfig.compilers.mjs;
    expect(compile("// config", "config/knip-vite-consumers.mjs")).toContain(
      'import { ShellSettingsSidebar as __solidLazy0 } from "../ui/src/components/settings-sidebar-shell.tsx";',
    );
    read.mockReturnValue("const SettingsSidebar = null;");
    expect(compile("// config", "config/knip-vite-consumers.mjs")).not.toContain(
      "ShellSettingsSidebar",
    );
  });

  it("models only Vite runner members consumed by the build", () => {
    const source = `const { module: routes } = await runnerImport<typeof import("./src/app-route-paths.ts")>(
  path.join(here, "src/app-route-paths.ts"), options);
const offlineShell = { routes: routes.APP_ROUTE_PATHS };`;
    const read = vi.spyOn(fs, "readFileSync").mockReturnValue(source);
    expect(knipConfig.workspaces["."].project).toContain("config/knip-vite-consumers.mjs!");
    const compile = knipConfig.compilers.mjs;
    const compiled = compile("// config", "config/knip-vite-consumers.mjs");
    expect(read).toHaveBeenCalledWith(path.resolve("ui/vite.config.ts"), "utf8");
    expect(compiled).toContain(
      'import { APP_ROUTE_PATHS as __vite0_0 } from "../ui/src/app-route-paths.ts";',
    );
    expect(compiled).not.toContain("APP_ROUTE_OFFLINE_PREFIXES");
    expect(compile(source, "config/unrelated.mjs")).toBe(source);
  });

  it("models the locale catalogue members consumed through Vite's runner", () => {
    const source = `const { module, dependencies } = await runnerImport<
  typeof import("../../scripts/lib/control-ui-i18n-catalog.ts")
>(sourceCatalogPath, options);
const startup = module.loadControlUiStartupCatalog();
const catalog = module.loadControlUiSourceCatalog();`;
    vi.spyOn(fs, "readFileSync").mockReturnValue(source);
    expect(scriptRootWorkspace.entry).toContain("config/knip.config.ts!");
    expect(scriptRootWorkspace.entry).toContain("config/knip-vite-consumers.mjs!");
    const compile = knipConfig.compilers.mjs;
    expect(compile("// config", "config/knip-vite-consumers.mjs")).toContain(
      'import { loadControlUiStartupCatalog as __vite0_0, loadControlUiSourceCatalog as __vite0_1 } from "../scripts/lib/control-ui-i18n-catalog.ts";',
    );
    const withoutStartup = source.replace(
      "const startup = module.loadControlUiStartupCatalog();",
      "",
    );
    vi.mocked(fs.readFileSync).mockReturnValue(withoutStartup);
    expect(compile("// config", "config/knip-vite-consumers.mjs")).not.toContain(
      "loadControlUiStartupCatalog",
    );
  });

  it("models ordinary UI Vite imports into the script workspace", () => {
    const source = `import { isControlUiOptionalAsset } from "../scripts/lib/control-ui-optional-assets.ts";`;
    vi.spyOn(fs, "readFileSync").mockReturnValue(source);
    const compile = knipConfig.compilers.mjs;
    expect(compile("// config", "config/knip-vite-consumers.mjs")).toContain(
      'import { isControlUiOptionalAsset } from "../scripts/lib/control-ui-optional-assets.ts";',
    );
    vi.mocked(fs.readFileSync).mockReturnValue("const config = {};");
    expect(compile("// config", "config/knip-vite-consumers.mjs")).not.toContain(
      "isControlUiOptionalAsset",
    );
  });

  it("models exact generated and module-hook named consumers", () => {
    expect(knipConfig.workspaces["."].project).toContain("config/knip-dynamic-consumers.mjs!");
    const compile = knipConfig.compilers.mjs;
    const compiled = compile("// dynamic consumers", "config/knip-dynamic-consumers.mjs");
    expect(compiled).toContain(
      'import { runtimeProcessDeployManifest as __dynamic0_0, runtimeProcessHelperManifest as __dynamic0_1, runtimeProcessWorkerDependencies as __dynamic0_2 } from "../src/infra/runtime-process-manifest.ts";',
    );
    expect(compiled).toContain(
      'import { gatewayBenchTaskOperation as __dynamic1_0 } from "../scripts/lib/gateway-bench-worker-messages.ts";',
    );
    expect(compiled).toContain(
      'import { fetchWithSsrFGuard as __dynamic2_0 } from "../extensions/team-reports/src/report-run.benchmark-fixtures.test-support.ts";',
    );
    expect(compiled).toContain(
      'import { addDoctorLegacyIssues as __dynamic3_0 } from "../src/commands/doctor/shared/legacy-config-issues.js";',
    );
    expect(compiled).toContain(
      'import { projectBundleMcpServerCatalog as __dynamic4_0 } from "../src/agents/agent-bundle-mcp-catalog-projection.js";',
    );
    expect(compiled).toContain(
      'import { observeNativeMcpProbe as __dynamic10_0 } from "../src/agents/native-mcp-connect.js";',
    );
    expect(compiled).toContain(
      'import { r2Task as __dynamic12_0, r2SearchStart as __dynamic12_1, r2SearchMatch as __dynamic12_2, r2SearchBuild as __dynamic12_3, r2SearchEnd as __dynamic12_4, r2PresentCalled as __dynamic12_5, r2PresentMiss as __dynamic12_6, r2Presentation as __dynamic12_7, r2Consume as __dynamic12_8, r2Materialized as __dynamic12_9 } from "../scripts/perf/session-row-churn-probe.js";',
    );
    expect(compiled).toMatch(
      /import \{ recordTrajectoryFlush as __dynamic\d+_0 \} from "\.\.\/scripts\/perf\/trajectory-flush-preload\.mts";/u,
    );

    const readFileSync = fs.readFileSync.bind(fs);
    const doctorConsumerPath = path.resolve("src/commands/config-preflight-snapshot.ts");
    const directDoctorConsumer = `const addIssues = (
  await import("./doctor/shared/legacy-config-issues.js")
).addDoctorLegacyIssues;`;
    const readFile = vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const source = readFileSync(file, options);
      return path.resolve(String(file)) === doctorConsumerPath ? directDoctorConsumer : source;
    });
    expect(compile("// dynamic consumers", "config/knip-dynamic-consumers.mjs")).toContain(
      'import { addDoctorLegacyIssues as __dynamic3_0 } from "../src/commands/doctor/shared/legacy-config-issues.js";',
    );

    readFile.mockImplementation((file, options) => {
      const source = readFileSync(file, options);
      if (path.resolve(String(file)) === path.resolve("tsdown.config.ts")) {
        return String(source).replace(
          `import {
  runtimeProcessDeployManifest,
  runtimeProcessHelperManifest,
  runtimeProcessWorkerDependencies,
} from "./src/infra/runtime-process-manifest.ts";`,
          "",
        );
      }
      if (
        path.resolve(String(file)) === path.resolve("scripts/lib/gateway-bench-worker-messages.ts")
      ) {
        return String(source).replace(
          "import { gatewayBenchTaskOperation as benchmarkTaskOperation } from ${JSON.stringify(import.meta.url)};",
          "",
        );
      }
      if (
        path.resolve(String(file)) === path.resolve("extensions/team-reports/src/sources/http.ts")
      ) {
        return String(source).replace(
          'import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";',
          "",
        );
      }
      if (
        path.resolve(String(file)) === path.resolve("scripts/perf/trajectory-flush-preload.mts")
      ) {
        return String(source).replace(
          "import { recordTrajectoryFlush as __recordTrajectoryFlush } from ${JSON.stringify(import.meta.url)};",
          "",
        );
      }
      if (path.resolve(String(file)) === doctorConsumerPath) {
        return String(source).replaceAll(").addDoctorLegacyIssues", ").consumeLegacyIssues");
      }
      return source;
    });
    const withoutConsumers = compile("// dynamic consumers", "config/knip-dynamic-consumers.mjs");
    expect(withoutConsumers).not.toContain("runtimeProcessDeployManifest");
    expect(withoutConsumers).not.toContain("runtimeProcessHelperManifest");
    expect(withoutConsumers).not.toContain("runtimeProcessWorkerDependencies");
    expect(withoutConsumers).not.toContain("gatewayBenchTaskOperation");
    expect(withoutConsumers).not.toContain("fetchWithSsrFGuard");
    expect(withoutConsumers).not.toContain("addDoctorLegacyIssues");
    expect(withoutConsumers).not.toContain("recordTrajectoryFlush");
  });

  it("removes projected MCP and Python edges with their actual consumers", () => {
    const runtimePath = path.resolve("src/agents/agent-bundle-mcp-runtime.ts");
    const instrumenterPath = path.resolve("scripts/perf/session-row-churn-instrument.py");
    const runtime = fs.readFileSync(runtimePath, "utf8");
    const instrumenter = fs.readFileSync(instrumenterPath, "utf8");
    const runtimeWithoutCatalogConsumer = replaceFixture(
      runtime,
      "catalog: { projectBundleMcpServerCatalog },",
      "catalog: {},",
    );
    const instrumenterWithoutTaskConsumer = replaceFixture(
      instrumenter,
      "edit('src/infra/main-thread-stall.ts',task)",
      "# removed main-thread task instrumentation",
    );
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const resolved = path.resolve(String(file));
      if (resolved === runtimePath) {
        return runtimeWithoutCatalogConsumer;
      }
      if (resolved === instrumenterPath) {
        return instrumenterWithoutTaskConsumer;
      }
      return readFileSync(file, options);
    });

    const compiled = knipConfig.compilers.mjs(
      "// dynamic consumers",
      "config/knip-dynamic-consumers.mjs",
    );
    expect(compiled).not.toContain("projectBundleMcpServerCatalog");
    expect(compiled).not.toContain("r2Task");
    expect(compiled).toContain("observeNativeMcpProbe");
    expect(compiled).toContain("r2Materialized");
  });

  it("models only declared materializer and emitted named-import consumers", () => {
    const compile = knipConfig.compilers.mjs;
    const compiled = compile("// dynamic consumers", "config/knip-dynamic-consumers.mjs");
    expect(compiled).toMatch(
      /import \{ materializeRuntimeProcessScriptFile as __dynamic\d+_0 \} from "\.\.\/src\/infra\/runtime-process-script-file\.ts";/u,
    );
    expect(compiled).toMatch(
      /import \{ resolveRuntimeBootstrapToolingEntrypointUrl as __dynamic\d+_0 \} from "\.\.\/runtime-process-bootstrap\.generated\.mjs";/u,
    );
    expect(compiled).toMatch(
      /import \{ isSqliteWalResetSafeVersion as __dynamic\d+_0 \} from "\.\.\/node-sqlite\.mjs";/u,
    );
    expect(compiled).toMatch(
      /import \{ PACKAGE_CLI_NODE_PROBE_SOURCE as __dynamic\d+_0 \} from "\.\.\/scripts\/lib\/package-cli-node-probe\.generated\.mjs";/u,
    );
    expect(compiled).not.toContain("HANDOFF_SCRIPT");

    const generatorPath = path.resolve("scripts/generate-runtime-script-assets.mjs");
    const prepareHooksPath = path.resolve("scripts/prepare-git-hooks.mjs");
    const workerArtifactsPath = path.resolve("test/scripts/vitest-worker-artifacts.test.ts");
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      const source = String(readFileSync(file, options));
      const resolved = path.resolve(String(file));
      if (resolved === generatorPath) {
        return replaceFixture(
          source,
          'import { materializeRuntimeProcessScriptFile } from "./src/infra/runtime-process-script-file.ts";',
          "",
        );
      }
      if (resolved === prepareHooksPath) {
        return replaceFixture(
          source,
          'import { resolveRuntimeBootstrapToolingEntrypointUrl } from "../runtime-process-bootstrap.generated.mjs";',
          "",
        );
      }
      if (resolved === workerArtifactsPath) {
        return replaceFixture(
          source,
          'import { isSqliteWalResetSafeVersion as isSafeVersion } from "../../node-sqlite.mjs";\\n',
          "const isSafeVersion = () => true;\\n",
        );
      }
      return source;
    });

    const withoutConsumers = compile("// dynamic consumers", "config/knip-dynamic-consumers.mjs");
    expect(withoutConsumers).not.toContain("materializeRuntimeProcessScriptFile");
    expect(withoutConsumers).not.toContain("resolveRuntimeBootstrapToolingEntrypointUrl");
    expect(withoutConsumers).not.toContain("isSqliteWalResetSafeVersion");
    expect(withoutConsumers).toContain("runtimeProcessDeployManifest");
    expect(withoutConsumers).toContain("observeNativeMcpProbe");
  });

  it.each([
    [
      "scripts/docs-link-audit.mjs",
      "./docs-link-audit.mts",
      '{ implementation: "./docs-link-audit.mts" }',
    ],
    [
      "scripts/verify-pr-hosted-gates.mjs",
      "./verify-pr-hosted-gates.mts",
      '{ implementation: "./verify-pr-hosted-gates.mts" }',
    ],
  ] as const)(
    "models literal typed shim %s without treating its implementation exports as entries",
    (file, implementation, literalOptions) => {
      const source = fs.readFileSync(file, "utf8");
      const compile = knipConfig.compilers.mjs;
      const compiled = compile(source, file);
      expect(compiled).toBe(`${source}\nimport ${JSON.stringify(implementation)};`);
      expect(scriptRootWorkspace.entry).toContain(`${file}!`);
      const implementationFile = path.join(path.dirname(file), implementation);
      expect(scriptRootWorkspace.entry).not.toContain(`${implementationFile}!`);
      expect(isEntry(scriptRootWorkspace.project, implementationFile)).toBe(true);

      const withoutImplementation = replaceFixture(source, literalOptions, "{}");
      expect(compile(withoutImplementation, file)).toBe(withoutImplementation);
    },
  );

  it("models retained updater named exports without fabricating private imports", () => {
    const manifest = fs.readFileSync("package.json", "utf8");
    const compile = knipConfig.compilers.json;
    const compiled = compile(manifest, "package.json");
    expect(compiled).toMatch(
      /import \{ isPackageManagerUpdateMode as __updateCompatibilityConsumer\d+ \} from "\.\/src\/cli\/update-cli\/update-command-service-recovery\.ts";/u,
    );
    for (const [module, symbol] of [
      ["src/cli/update-cli/update-command-package.ts", "readPackageUpdateIdentity"],
      [
        "src/infra/update-managed-service-handoff.ts",
        "isCurrentManagedServiceUpdateHandoffProcess",
      ],
      ["src/infra/update-runner-git-target.ts", "readGitTargetSchemaVersions"],
    ]) {
      expect(
        compiled
          .split("\n")
          .some(
            (line) =>
              line.startsWith(`import { ${symbol} as `) && line.endsWith(` from "./${module}";`),
          ),
      ).toBe(false);
      expect(compiled).toContain(`from "./${module}";`);
    }
    const finishAliases = [
      ...compiled.matchAll(
        /import \{ finishUpdateRun as (__updateCompatibilityConsumer\d+) \} from "\.\/src\/infra\/update-run-(?:ledger|write)\.ts";/gu,
      ),
    ].map((match) => match[1]);
    expect(finishAliases).toHaveLength(2);
    expect(new Set(finishAliases).size).toBe(2);
  });

  it("rejects retained updater bindings that are neither exports nor real imports", () => {
    const manifest = fs.readFileSync("package.json", "utf8");
    const inventoryPath = path.resolve("scripts/lib/update-compat-inventory.json");
    const inventory = structuredClone(readUpdateCompatibilityInventory(inventoryPath));
    inventory.releases[0]!.chunks[0]!.exports.push({
      exported: "missingUpdaterConsumer",
      origin: {
        module: "src/cli/update-cli/update-command-service-recovery.ts",
        symbol: "missingUpdaterConsumer",
      },
    });
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      return path.resolve(String(file)) === inventoryPath
        ? JSON.stringify(inventory)
        : readFileSync(file, options);
    });
    expect(() => knipConfig.compilers.json(manifest, "package.json")).toThrow(
      "Recorded updater binding src/cli/update-cli/update-command-service-recovery.ts:missingUpdaterConsumer is neither a named export nor an imported named binding",
    );
  });

  it("rejects findings from every compact export section and expands symbol lists", () => {
    const output = [
      "Unused exports (2)\nsrc/b.ts: beta, alpha\n/tmp/outside.ts: noise\nC:\\tmp\\outside.ts: noise\nC:outside.ts: noise\n\\\\server\\share\\outside.ts: noise",
      "Unused exported types (1)\nextensions/example/src/types.ts: ExampleType",
      "Unused exported enum members (1)\npackages/example/src/state.ts: Ready",
      "Exports in used namespace (1)\nsrc/namespace.ts: runtimeHelper",
      "Exported types in used namespace (1)\nsrc/namespace.ts: RuntimeType",
      "Unused exported namespace members (1)\nsrc/protocol.ts: Result (v2)",
      "Unused files (1)\nsrc/noise.ts: src/noise.ts",
    ].join("\n\n");
    const entries = [
      "extensions/example/src/types.ts: ExampleType",
      "packages/example/src/state.ts: Ready",
      "src/b.ts: alpha",
      "src/b.ts: beta",
      "src/namespace.ts: runtimeHelper",
      "src/namespace.ts: RuntimeType",
      "src/protocol.ts: Result (v2)",
    ];
    expect(checkExportScan("finding scan", `\n${output}\n`)).toEqual({
      entries,
      message: `finding scan:\nUnused exports are not allowed:\n${entries.map((entry) => `  ${entry}`).join("\n")}\nDelete the exports or model their real production consumers in Knip.`,
      ok: false,
    });
  });

  it.each([
    ["Configuration error: invalid project\n", false],
    ["Unused exports (0)\n", true],
  ] as const)("distinguishes section presence in %s", (output, sawExportSection) => {
    expect(parseKnipCompactUnusedExportsResult(output)).toEqual({
      entries: [],
      sawExportSection,
    });
  });

  it("discards export findings after workspace module resolution failures", () => {
    const errors = [
      "ERROR: Error loading vitest.config.ts (Cannot find module 'vitest/config')",
      "ERROR: Error loading ui/vite.config.ts (Cannot find module 'vite')",
    ].join("\n");
    expect(
      checkExportScan(
        "production unused-export scan",
        `${errors}\nUnused exports (1)\nsrc/config/types.ts: TelegramConfig\n`,
      ),
    ).toEqual({
      ok: false,
      entries: [],
      message: `deadcode production unused-export scan could not resolve workspace modules; export findings would be unreliable and are discarded.
${errors}
Install workspace dependencies in-tree (pnpm install) — on delegated boxes the crabbox wrapper links the hydrated modules dir into the workdir — and rerun.`,
    });
  });

  it("accepts clean export scan output unchanged", () => {
    expect(checkExportScan("clean scan", "")).toEqual({ entries: [], message: "", ok: true });
  });
});
