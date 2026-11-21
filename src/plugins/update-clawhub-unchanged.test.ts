import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as artifacts from "../infra/clawhub-artifacts.js";
import * as packages from "../infra/clawhub-packages.js";
import { clawHubSecurityResponse, clawHubVersionMetadata } from "./clawhub.test-fixtures.js";
import {
  createClawHubArchiveFactory,
  DEMO_PLUGIN_ARCHIVE_ENTRIES,
  sha256Hex,
} from "./clawhub.test-support.js";
import * as installer from "./install.js";
import {
  acceptCapabilities,
  singleInstallConfig,
  withPluginState,
} from "./update-authority.test-support.js";
import { updateNpmInstalledPlugins } from "./update-installed.js";

const createArchive = createClawHubArchiveFactory(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  "identical",
  "changed digest",
  "missing entry",
  "missing manifest",
  "broken host dependency",
  "file-list only",
  "dry run",
  "blocked release",
  "incompatible release",
])("updates a verified ClawHub artifact: %s", async (scenario) => {
  await withPluginState("clawhub-unchanged", async (state) => {
    const archive = await createArchive(DEMO_PLUGIN_ARCHIVE_ENTRIES);
    const installPath = state.statePath("extensions", "demo");
    await fs.mkdir(installPath, { recursive: true });
    for (const [name, contents] of Object.entries(DEMO_PLUGIN_ARCHIVE_ENTRIES)) {
      await fs.writeFile(path.join(installPath, name), contents);
    }
    const before = await fs.stat(path.join(installPath, "index.js"));
    if (scenario === "missing entry") {
      await fs.rm(path.join(installPath, "index.js"));
    }
    if (scenario === "missing manifest") {
      await fs.rm(path.join(installPath, "openclaw.plugin.json"));
    }
    if (scenario === "broken host dependency") {
      const manifest = JSON.parse(DEMO_PLUGIN_ARCHIVE_ENTRIES["package.json"]);
      await fs.writeFile(
        path.join(installPath, "package.json"),
        JSON.stringify({
          ...manifest,
          peerDependencies: { openclaw: "*" },
        }),
      );
    }
    vi.spyOn(packages, "fetchClawHubPackageDetail").mockResolvedValue({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
        createdAt: 0,
        updatedAt: 0,
        latestVersion: "2026.3.22",
      },
    });
    vi.spyOn(packages, "fetchClawHubPackageArtifact").mockResolvedValue(
      clawHubVersionMetadata({
        ...(scenario === "file-list only"
          ? {
              files: Object.entries(DEMO_PLUGIN_ARCHIVE_ENTRIES).map(([filePath, contents]) => ({
                path: filePath,
                sha256: sha256Hex(contents),
              })),
            }
          : { sha256hash: archive.integrity }),
        ...(scenario === "incompatible release"
          ? { compatibility: { pluginApiRange: ">=2099.1.1" } }
          : {}),
      }),
    );
    const security = vi.spyOn(packages, "fetchClawHubPackageSecurity").mockResolvedValue(
      clawHubSecurityResponse("demo", "2026.3.22", {
        blockedFromDownload: scenario === "blocked release",
      }),
    );
    vi.spyOn(artifacts, "downloadClawHubPackageArchive").mockResolvedValue({
      ...archive,
      artifact: "archive",
      sha256Hex: Buffer.from(archive.integrity.slice("sha256-".length), "base64").toString("hex"),
      cleanup: async () => {},
    });
    const install = vi.spyOn(installer, "installPluginFromArchive");
    const config = singleInstallConfig("demo", {
      source: "clawhub",
      spec: "clawhub:demo@2026.3.22",
      version: "2026.3.22",
      installPath,
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      artifactKind: "legacy-zip",
      integrity:
        scenario === "changed digest"
          ? "sha256-" + Buffer.alloc(32).toString("base64")
          : archive.integrity,
    });
    const result = await updateNpmInstalledPlugins({
      config,
      onCapabilityConsent: acceptCapabilities,
      dryRun: scenario === "dry run",
    });
    const rejected = scenario === "blocked release" || scenario === "incompatible release";
    const replaced = [
      "changed digest",
      "missing entry",
      "missing manifest",
      "broken host dependency",
      "file-list only",
    ].includes(scenario);
    expect(result.outcomes[0]?.status).toBe(rejected ? "error" : "unchanged");
    expect(result.changed).toBe(replaced);
    expect(install).toHaveBeenCalledTimes(replaced || scenario === "dry run" ? 1 : 0);
    if (scenario !== "incompatible release") {
      expect(security).toHaveBeenCalledOnce();
    }
    if (!replaced) {
      expect(result.config).toBe(config);
      expect((await fs.stat(path.join(installPath, "index.js"))).ino).toBe(before.ino);
    } else {
      expect(await fs.readFile(path.join(installPath, "index.js"), "utf8")).toBe(
        DEMO_PLUGIN_ARCHIVE_ENTRIES["index.js"],
      );
    }
  });
});
