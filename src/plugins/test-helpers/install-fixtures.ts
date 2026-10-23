import fs from "node:fs";
import path from "node:path";
import { withTempDir } from "../../test-utils/temp-dir.js";
import type { PluginInstallArtifactConsentHandler } from "../install-types.js";
import { createColdPluginFixture } from "./cold-plugin-fixtures.js";

type BundleFixtureFormat = "agent" | "codex" | "claude" | "cursor";
type BundleFixtureParams = { bundleFormat: BundleFixtureFormat; name: string };

function writeFixtureFiles(rootDir: string, files: Record<string, string | object>) {
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const source = typeof content === "string" ? content : JSON.stringify(content);
    fs.writeFileSync(filePath, source, "utf8");
  }
}

const skillSource = "---\ndescription: fixture\n---\n";

type PluginArtifactInstallMockParams = {
  onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
};

export async function invokePluginArtifactInstallMock<
  TResult extends { ok: boolean; pluginId?: string; version?: string },
>(
  mock: unknown,
  params: PluginArtifactInstallMockParams,
  fixture?: { manifest?: Record<string, unknown> },
): Promise<TResult> {
  const result = await (mock as (params: PluginArtifactInstallMockParams) => Promise<TResult>)(
    params,
  );
  const reviewArtifact = params.onBeforePluginArtifactCommit;
  const pluginId = result.pluginId;
  if (
    !result.ok ||
    !pluginId ||
    !reviewArtifact ||
    params.dryRun ||
    (params.expectedPluginId && params.expectedPluginId !== pluginId)
  ) {
    return result;
  }
  return await withTempDir("openclaw-plugin-staged-", async (rootDir) => {
    const stagedArtifactDir = fs.realpathSync(rootDir);
    createColdPluginFixture({
      rootDir: stagedArtifactDir,
      pluginId,
      ...(result.version ? { packageVersion: result.version } : {}),
      ...(fixture?.manifest ? { manifest: fixture.manifest } : {}),
    });
    await reviewArtifact({
      pluginId,
      stagedArtifactDir,
      mode: params.mode ?? "install",
    });
    return result;
  });
}

export function createBundleInstallFixtureFactory(makeTempDir: () => string) {
  return function setupBundleInstallFixture(params: BundleFixtureParams) {
    const { bundleFormat: format, name } = params;
    const caseDir = makeTempDir();
    const stateDir = path.join(caseDir, "state");
    const pluginDir = path.join(caseDir, "plugin-src");
    fs.mkdirSync(stateDir, { recursive: true });
    const manifestPath = format === "agent" ? "plugin.json" : `.${format}-plugin/plugin.json`;
    const skillPath = format === "agent" ? "skills/fixture/SKILL.md" : "skills/SKILL.md";
    writeFixtureFiles(pluginDir, {
      [manifestPath]: {
        ...(format === "agent"
          ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" }
          : {}),
        name,
        description: `${format} bundle fixture`,
        ...(format === "codex" ? { skills: "skills" } : {}),
      },
      ...(format === "cursor" ? { ".cursor/commands/review.md": skillSource } : {}),
      [skillPath]: skillSource,
    });
    return { pluginDir, extensionsDir: path.join(stateDir, "extensions") };
  };
}

export function createDualFormatInstallFixtureFactory(makeTempDir: () => string) {
  return function setupDualFormatInstallFixture(params: { bundleFormat: "codex" | "claude" }) {
    const { bundleFormat } = params;
    const caseDir = makeTempDir();
    const pluginDir = path.join(caseDir, "plugin-src");
    writeFixtureFiles(pluginDir, {
      "package.json": {
        name: "@openclaw/native-dual",
        version: "0.0.1",
        openclaw: { extensions: ["./dist/index.js"] },
        dependencies: { "left-pad": "1.3.0" },
      },
      "openclaw.plugin.json": {
        id: "native-dual",
        configSchema: { type: "object", properties: {} },
        skills: ["skills"],
      },
      "dist/index.js": "export {};",
      "skills/SKILL.md": skillSource,
      [`.${bundleFormat}-plugin/plugin.json`]: {
        name: "Bundle Fallback",
        ...(bundleFormat === "codex" ? { skills: "skills" } : {}),
      },
    });
    return { pluginDir, extensionsDir: path.join(caseDir, "state", "extensions") };
  };
}
