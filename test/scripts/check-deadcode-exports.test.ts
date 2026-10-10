// Check Deadcode Exports tests cover parsing and hard-zero enforcement.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import allExportsKnipConfig from "../../config/knip.all-exports.config.ts";
import knipConfig from "../../config/knip.config.ts";
import scriptExportsKnipConfig from "../../config/knip.scripts-exports.config.ts";
import {
  checkExportScan,
  parseKnipCompactUnusedExports,
  parseKnipCompactUnusedExportsResult,
} from "../../scripts/check-deadcode-exports.mts";
import { vitestWorkerBuildEntries } from "../../scripts/lib/vitest-worker-build-entries.mts";
import { vitestWorkerDeclarationEntries } from "../../scripts/lib/vitest-worker-declarations.mts";

const fullRootWorkspace = allExportsKnipConfig.workspaces["."];
const fullExtensionWorkspace = allExportsKnipConfig.workspaces["extensions/*"];
const fullUiWorkspace = allExportsKnipConfig.workspaces.ui;
const scriptRootWorkspace = scriptExportsKnipConfig.workspaces["."];
if (!fullRootWorkspace || !fullExtensionWorkspace || !fullUiWorkspace || !scriptRootWorkspace) {
  throw new Error("deadcode Knip configs must define root, extension, and UI workspaces");
}

describe("check-deadcode-exports", () => {
  it("makes tests in every workspace roots of the full-tree export audit", () => {
    expect(knipConfig.workspaces["."].entry).not.toContain(
      "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
    );
    expect(knipConfig.workspaces["."].entry).toEqual(
      expect.arrayContaining([
        "config/knip.config.ts!",
        "config/knip.all-exports.config.ts!",
        "config/knip.scripts-exports.config.ts!",
      ]),
    );
    expect(knipConfig.workspaces["."].project).toContain("config/**/*.{ts,mts,cts}!");
    expect(fullRootWorkspace.entry).toEqual(
      expect.arrayContaining([
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        "src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "scripts/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "test/vitest/vitest*.config.ts!",
        "scripts/crabbox-wrapper.mjs!",
        "scripts/crabbox-wrapper.mts!",
        "scripts/check-openclaw-package-tarball.mjs!",
        "scripts/check-openclaw-package-tarball.mts!",
      ]),
    );
    expect(fullExtensionWorkspace.entry).toContain("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!");
    expect(fullUiWorkspace.entry).toContain("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!");
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
    expect(scriptRootWorkspace.entry).toEqual(
      expect.arrayContaining([
        ".agents/skills/**/scripts/**/*.{js,mjs,cjs,ts,mts,cts}!",
        ".github/actions/setup-node-env/dependency-fingerprint.mjs!",
        "apps/android/scripts/build-release-artifacts.ts!",
        "security/opengrep/check-rule-metadata.mjs!",
        "skills/meme-maker/scripts/meme.mjs!",
        "scripts/check-openclaw-package-tarball.mts!",
        "scripts/crabbox-wrapper.mjs!",
        "scripts/crabbox-wrapper.mts!",
        "scripts/lib/vitest-resource-reporter.mts!",
        "scripts/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}!",
        "src/plugin-sdk/api-baseline.ts!",
      ]),
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

  it("models upgrade survivor inline imports from the shell source", () => {
    const runner = "scripts/e2e/lib/upgrade-survivor/run.sh";
    const source = fs.readFileSync(runner, "utf8");
    const compile = knipConfig.compilers.sh;
    for (const workspace of [knipConfig.workspaces["."], fullRootWorkspace, scriptRootWorkspace]) {
      expect(workspace.entry).toContain(`${runner}!`);
    }
    expect(compile(source, runner)).toContain(
      'import { readPostCoreSnapshot } from "./diagnostics.mjs";',
    );
    const withoutSnapshot = source.replace(/^import \{ readPostCoreSnapshot \}[^\n]+\n/mu, "");
    const remaining = compile(withoutSnapshot, runner);
    expect(remaining).not.toContain("readPostCoreSnapshot");
    expect(remaining).toContain('from "../../../lib/release-version.mjs";');
    expect(compile(source, "scripts/e2e/lib/upgrade-survivor/other.sh")).toBe("");
  });

  it("parses all compact export sections and expands symbol lists", () => {
    expect(
      parseKnipCompactUnusedExports(`
Unused exports (2)
src/b.ts: beta, alpha
/tmp/outside.ts: noise
C:\\tmp\\outside.ts: noise
C:outside.ts: noise
\\\\server\\share\\outside.ts: noise

Unused exported types (1)
extensions/example/src/types.ts: ExampleType

Unused exported enum members (1)
packages/example/src/state.ts: Ready

Exports in used namespace (1)
src/namespace.ts: runtimeHelper

Exported types in used namespace (1)
src/namespace.ts: RuntimeType

Unused exported namespace members (1)
src/protocol.ts: Result (v2)

Unused files (1)
src/noise.ts: src/noise.ts
`),
    ).toEqual([
      "extensions/example/src/types.ts: ExampleType",
      "packages/example/src/state.ts: Ready",
      "src/b.ts: alpha",
      "src/b.ts: beta",
      "src/namespace.ts: runtimeHelper",
      "src/namespace.ts: RuntimeType",
      "src/protocol.ts: Result (v2)",
    ]);
  });

  it("distinguishes a failed scan with no export sections from zero findings", () => {
    expect(parseKnipCompactUnusedExportsResult("Configuration error: invalid project\n")).toEqual({
      entries: [],
      sawExportSection: false,
    });
    expect(parseKnipCompactUnusedExportsResult("Unused exports (0)\n")).toEqual({
      entries: [],
      sawExportSection: true,
    });
  });

  it("discards export findings after workspace module resolution failures", () => {
    const output = `ERROR: Error loading vitest.config.ts (Cannot find module 'vitest/config')
ERROR: Error loading ui/vite.config.ts (Cannot find module 'vite')
Unused exports (1)
src/config/types.ts: TelegramConfig
`;

    const result = checkExportScan("production unused-export scan", output);
    expect(result.ok).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.message).toContain(
      "deadcode production unused-export scan could not resolve workspace modules; export findings would be unreliable and are discarded.",
    );
    expect(result.message).toContain("ERROR: Error loading vitest.config.ts");
    expect(result.message).toContain("ERROR: Error loading ui/vite.config.ts");
    expect(result.message).toContain("Install workspace dependencies in-tree (pnpm install)");
    expect(result.message).not.toContain("Unused exports are not allowed");
    expect(result.message).not.toContain("src/config/types.ts: TelegramConfig");
  });

  it("accepts clean export scan output unchanged", () => {
    expect(checkExportScan("clean scan", "")).toEqual({ entries: [], message: "", ok: true });
  });

  it("reports genuine export findings unchanged", () => {
    expect(
      checkExportScan("finding scan", "Unused exports (1)\nsrc/config/types.ts: TelegramConfig\n"),
    ).toEqual({
      entries: ["src/config/types.ts: TelegramConfig"],
      message: `finding scan:
Unused exports are not allowed:
  src/config/types.ts: TelegramConfig
Delete the exports or model their real production consumers in Knip.`,
      ok: false,
    });
  });
});
