import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createClawHubArchiveFactory } from "./clawhub.test-support.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { installManagedPlugin } from "./management-mutations.js";

const clawhub = vi.hoisted(() => ({
  detail: vi.fn(),
  artifact: vi.fn(),
  download: vi.fn(),
  officialCatalog: vi.fn(async () => ({ source: "hosted" as const, entries: [] })),
}));

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: clawhub.detail,
  fetchClawHubPackageArtifact: clawhub.artifact,
}));
vi.mock("../infra/clawhub-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-artifacts.js")>()),
  downloadClawHubPackageArchive: clawhub.download,
}));
vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: clawhub.officialCatalog,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const createClawHubArchive = createClawHubArchiveFactory(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function writePluginSource(root: string, tool: string): Promise<string> {
  const sourceDir = path.join(root, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({
      name: "@example/claw-audit",
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(sourceDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "claw-audit",
      contracts: { tools: [tool] },
      configSchema: { type: "object" },
    }),
  );
  await fs.writeFile(path.join(sourceDir, "index.js"), "export {};\n");
  return sourceDir;
}

describe("Claw-managed plugin capability consent", () => {
  it("denies an official ClawHub plugin before artifact and record commit, then installs after review", async () => {
    const root = dirs.make("openclaw-official-claw-plugin-consent-");
    const archive = await createClawHubArchive({
      "package.json": JSON.stringify({
        name: "@openclaw/diffs",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      }),
      "openclaw.plugin.json": JSON.stringify({
        id: "diffs",
        contracts: { tools: ["audit.read"] },
        configSchema: { type: "object" },
      }),
      "index.js": "export {};\n",
    });
    clawhub.detail.mockResolvedValue({
      package: {
        name: "@openclaw/diffs",
        displayName: "Diffs",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        runtimeId: "diffs",
        latestVersion: "1.0.0",
        createdAt: 0,
        updatedAt: 0,
      },
    });
    clawhub.artifact.mockResolvedValue({
      version: { version: "1.0.0", sha256hash: archive.integrity },
    });
    clawhub.download.mockResolvedValue({ ...archive, cleanup: async () => {} });
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_CLAWHUB_URL: undefined,
      CLAWHUB_URL: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");
    const request = {
      source: "clawhub" as const,
      packageName: "@openclaw/diffs",
      version: "1.0.0",
      expectedIntegrity: archive.integrity,
    };

    await withEnvAsync(env, async () => {
      const denied = vi.fn(async () => undefined);
      await expect(
        installManagedPlugin({ request, env, clawManaged: true, onCapabilityConsent: denied }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
      expect(denied).toHaveBeenCalledWith(
        expect.objectContaining({ declared: expect.objectContaining({ tools: ["audit.read"] }) }),
      );
      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "diffs")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toBeFalsy();

      const accepted = vi.fn(async (review: { reviewToken: string }) => ({
        reviewToken: review.reviewToken,
      }));
      await expect(
        installManagedPlugin({ request, env, clawManaged: true, onCapabilityConsent: accepted }),
      ).resolves.toMatchObject({ plugin: { id: "diffs", installed: true } });
      expect(accepted).toHaveBeenCalledOnce();
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.diffs).toMatchObject({
        source: "clawhub",
        clawhubPackage: "@openclaw/diffs",
        integrity: archive.integrity,
      });
    });
  });

  it("rejects missing consent before publishing an artifact or install record", async () => {
    const root = dirs.make("openclaw-claw-plugin-consent-");
    const sourceDir = await writePluginSource(root, "audit.read");
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");

    await withEnvAsync(env, async () => {
      await expect(
        installManagedPlugin({
          request: { source: "local", path: sourceDir },
          env,
          clawManaged: true,
        }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

      await expect(
        fs.stat(path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]).toBeFalsy();
    });
  });

  it("keeps the installed artifact and record unchanged when update consent is denied", async () => {
    const root = dirs.make("openclaw-claw-plugin-update-consent-");
    const sourceDir = await writePluginSource(root, "audit.read");
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}");

    await withEnvAsync(env, async () => {
      const reviewed: string[][] = [];
      await installManagedPlugin({
        request: { source: "local", path: sourceDir },
        env,
        clawManaged: true,
        onCapabilityConsent: async (review) => {
          reviewed.push(review.declared.tools);
          return { reviewToken: review.reviewToken };
        },
      });
      expect(reviewed).toEqual([["audit.read"]]);
      const artifactDir = path.join(resolveDefaultPluginExtensionsDir(env), "claw-audit");
      const originalArtifact = await fs.readFile(path.join(artifactDir, "openclaw.plugin.json"));
      const originalRecord = readPersistedInstalledPluginIndexInstallRecords({ env })?.[
        "claw-audit"
      ];
      expect(originalRecord?.acceptedSurface?.tools).toEqual(["audit.read"]);

      await writePluginSource(root, "audit.write");
      await expect(
        installManagedPlugin({
          request: { source: "local", path: sourceDir, mode: "update" },
          env,
          clawManaged: true,
          onCapabilityConsent: async (review) => {
            reviewed.push(review.declared.tools);
            return undefined;
          },
        }),
      ).rejects.toMatchObject({ capabilityConsent: { pluginId: "claw-audit" } });

      expect(reviewed).toEqual([["audit.read"], ["audit.write"]]);
      expect(await fs.readFile(path.join(artifactDir, "openclaw.plugin.json"))).toEqual(
        originalArtifact,
      );
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.["claw-audit"]).toEqual(
        originalRecord,
      );
    });
  });
});
