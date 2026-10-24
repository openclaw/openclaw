import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const isEntry = (entries: readonly string[], file: string) =>
  entries.some((entry) => path.matchesGlob(file, entry.replace(/!$/u, "")));
afterEach(() => vi.restoreAllMocks());

describe("check-deadcode-exports", () => {
  it("makes tests in every workspace roots of the full-tree export audit", () => {
    expectEntries(knipConfig.workspaces["."].entry, [
      "config/knip.config.ts!",
      "config/knip.all-exports.config.ts!",
      "config/knip.scripts-exports.config.ts!",
    ]);
    expect(knipConfig.workspaces["."].project).toContain("config/**/*.{ts,mts,cts}!");
    expectEntries(fullRootWorkspace.entry, [
      "test/vitest/vitest*.config.ts!",
      "scripts/crabbox-wrapper.mjs!",
      "scripts/crabbox-wrapper.mts!",
      "scripts/check-openclaw-package-tarball.mjs!",
      "scripts/check-openclaw-package-tarball.mts!",
    ]);
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
    expect(
      scriptExportsKnipConfig.ignoreIssues["scripts/lib/vitest-resource-reporter.mts"],
    ).toEqual(["exports"]);
    expect(scriptExportsKnipConfig.ignoreIssues).toHaveProperty("src/**");
    expect(scriptExportsKnipConfig.ignoreIssues).toHaveProperty(
      "scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs",
    );
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
