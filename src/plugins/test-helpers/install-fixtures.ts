import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "../../test-utils/temp-dir.js";
import type { PluginInstallArtifactConsentHandler } from "../install-types.js";
import { writeArtifacts as writeFixtureFiles } from "../public-surface.test-support.js";
import { createColdPluginFixture } from "./cold-plugin-fixtures.js";

type BundleFixtureFormat = "agent" | "codex" | "claude" | "cursor";
type BundleFixtureParams = { bundleFormat: BundleFixtureFormat; name: string };

const skillSource = "---\ndescription: fixture\n---\n";

type InstallMockParams = {
  onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
};

export async function invokePluginArtifactInstallMock<
  TResult extends { ok: boolean; pluginId?: string; version?: string },
>(
  mock: unknown,
  params: InstallMockParams,
  fixture?: { manifest?: Record<string, unknown> },
): Promise<TResult> {
  const result = await (mock as (params: InstallMockParams) => Promise<TResult>)(params);
  const reviewArtifact = params.onBeforePluginArtifactCommit;
  const { pluginId, version } = result;
  if (
    !result.ok ||
    !pluginId ||
    !reviewArtifact ||
    params.dryRun ||
    (params.expectedPluginId && params.expectedPluginId !== pluginId)
  ) {
    return result;
  }
  return await withTempDir("openclaw-plugin-staged-", async (dir) => {
    const rootDir = fs.realpathSync(dir);
    const { manifest } = fixture ?? {};
    createColdPluginFixture({ rootDir, pluginId, packageVersion: version || undefined, manifest });
    await reviewArtifact({ pluginId, stagedArtifactDir: rootDir, mode: params.mode ?? "install" });
    return result;
  });
}

export function createBundleInstallFixtureFactory(makeTempDir: () => string) {
  return ({ bundleFormat: format, name }: BundleFixtureParams) => {
    const caseDir = makeTempDir();
    const stateDir = path.join(caseDir, "state");
    const pluginDir = path.join(caseDir, "plugin-src");
    fs.mkdirSync(stateDir, { recursive: true });
    writeFixtureFiles(pluginDir, {
      [format === "agent" ? "plugin.json" : `.${format}-plugin/plugin.json`]: {
        $schema:
          format === "agent"
            ? "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
            : undefined,
        name,
        description: `${format} bundle fixture`,
        skills: format === "codex" ? "skills" : undefined,
      },
      ...(format === "cursor" ? { ".cursor/commands/review.md": skillSource } : {}),
      [format === "agent" ? "skills/fixture/SKILL.md" : "skills/SKILL.md"]: skillSource,
    });
    return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
  };
}

export function createDualFormatInstallFixtureFactory(makeTempDir: () => string) {
  const setupBundle = createBundleInstallFixtureFactory(makeTempDir);
  return ({ bundleFormat }: { bundleFormat: "codex" | "claude" }) => {
    const fixture = setupBundle({ bundleFormat, name: "Bundle Fallback" });
    writeFixtureFiles(fixture.pluginDir, {
      "package.json": {
        name: "@openclaw/native-dual",
        version: "0.0.1",
        openclaw: { extensions: ["./dist/index.js"] },
        dependencies: { "left-pad": "1.3.0" },
      },
      "openclaw.plugin.json": { id: "native-dual", configSchema: { type: "object" } },
      "dist/index.js": "export {};",
    });
    return fixture;
  };
}
