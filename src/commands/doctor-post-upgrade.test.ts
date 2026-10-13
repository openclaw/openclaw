import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { fetchClawHubPackageDetail } from "../infra/clawhub-packages.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
} from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { pluginCacheExistsSync } from "../plugins/plugin-cache-files.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { VERSION } from "../version.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  VERSION: "2026.9.4",
}));

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: vi.fn(),
}));

async function makeFixtureRoot(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `doctor-post-upgrade-${prefix}-`));
}

async function cleanupFixtureRoot(root: string): Promise<void> {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseByPath(resolveInstalledPluginIndexStorePath({ stateDir: root }));
  await fs.rm(root, { recursive: true, force: true });
}

function createIndex(
  plugins: InstalledPluginIndex["plugins"],
  installRecords: InstalledPluginIndex["installRecords"] = {},
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test-host",
    compatRegistryVersion: "test-compat",
    migrationVersion: 1,
    policyHash: "test-policy",
    generatedAtMs: 1,
    installRecords,
    plugins,
    diagnostics: [],
  };
}

async function withFixtureRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await makeFixtureRoot(prefix);
  try {
    return await run(root);
  } finally {
    await cleanupFixtureRoot(root);
  }
}

async function writePluginFixture(
  root: string,
  params: {
    id: string;
    location?: string;
    packageJson?: unknown;
    packageJsonRaw?: string;
    files?: Record<string, string>;
    origin?: InstalledPluginIndex["plugins"][number]["origin"];
    includePackageJsonRecord?: boolean;
    manifest?: Record<string, unknown> | false;
    manifestHash?: string;
    enabled?: boolean;
    format?: InstalledPluginIndex["plugins"][number]["format"];
    bundleFormat?: InstalledPluginIndex["plugins"][number]["bundleFormat"];
    installRecord?: PluginInstallRecord;
  },
) {
  const pluginDir = path.join(root, params.location ?? "user-plugins", params.id);
  await fs.mkdir(pluginDir, { recursive: true });
  for (const [relativePath, contents] of Object.entries(params.files ?? {})) {
    const pathname = path.join(pluginDir, relativePath);
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    await fs.writeFile(pathname, contents, "utf-8");
  }
  const hasPackageJson =
    Object.hasOwn(params, "packageJson") || params.packageJsonRaw !== undefined;
  if (hasPackageJson) {
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      params.packageJsonRaw ?? JSON.stringify(params.packageJson),
      "utf-8",
    );
  }
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  if (params.manifest !== false) {
    await fs.writeFile(manifestPath, JSON.stringify(params.manifest ?? { id: params.id }), "utf-8");
  }
  await writePersistedInstalledPluginIndex(
    createIndex(
      [
        {
          pluginId: params.id,
          rootDir: pluginDir,
          enabled: params.enabled ?? true,
          origin: params.origin ?? "global",
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
          ...(hasPackageJson && params.includePackageJsonRecord !== false
            ? { packageJson: { path: "package.json", hash: "package-hash" } }
            : {}),
          manifestPath: params.manifest === false ? "" : manifestPath,
          manifestHash: params.manifestHash ?? "",
          ...(params.format ? { format: params.format } : {}),
          ...(params.bundleFormat ? { bundleFormat: params.bundleFormat } : {}),
        },
      ],
      params.installRecord ? { [params.id]: params.installRecord } : {},
    ),
    { stateDir: root },
  );
  return { manifestPath };
}

function packageManifest(name: string, entry = "./dist/index.js") {
  return { name, version: "0.0.1", type: "module", openclaw: { extensions: [entry] } };
}

async function writeDeclaredPackageFixture(root: string, packageContents: string): Promise<void> {
  await writePluginFixture(root, {
    id: "broken",
    packageJsonRaw: packageContents,
    manifest: false,
  });
}

describe("runPostUpgradeProbes — plugin.index_unavailable", () => {
  it("returns a structured finding when the installed plugin index is missing", async () => {
    await withFixtureRoot("index-missing", async (root) => {
      const report = await runPostUpgradeProbes({ stateDir: root });

      expect(report.probesRun).toContain("plugin.index_unavailable");
      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.index_unavailable",
        }),
      ]);
    });
  });
});

describe("runPostUpgradeProbes — plugin.entry_unresolved", () => {
  it("reports unreadable plugin packages as structured errors without losing JSON console diagnostics", async () => {
    const root = await makeFixtureRoot("entry-unreadable-json");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    try {
      await writePersistedInstalledPluginIndex(
        createIndex([
          {
            pluginId: "broken",
            rootDir: path.join(root, "broken"),
            enabled: true,
            origin: "global",
            startup: { sidecar: false, memory: false, agentHarnesses: [] },
            compat: [],
            manifestPath: "",
            manifestHash: "",
            packageJson: { path: "missing-package.json", hash: "package-hash" },
          },
        ]),
        { stateDir: root },
      );
      setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });

      const report = await runPostUpgradeProbes({ stateDir: root });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.entry_unresolved",
          plugin: "broken",
          entry: "missing-package.json",
          message: expect.stringContaining("openclaw plugins registry --refresh"),
        }),
      ]);
      const line = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
      expect(JSON.parse(line)).toMatchObject({
        level: "warn",
        message: expect.stringContaining("could not read package.json for broken"),
      });
    } finally {
      stderrSpy.mockRestore();
      resetLogger();
      await cleanupFixtureRoot(root);
    }
  });

  it("rejects a non-object declared package manifest", async () => {
    const root = await makeFixtureRoot("entry-non-object");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    try {
      await writeDeclaredPackageFixture(root, "null");
      const report = await runPostUpgradeProbes({ stateDir: root });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.entry_unresolved",
          plugin: "broken",
          entry: "package.json",
          message: expect.stringContaining("package.json must contain a JSON object"),
        }),
      ]);
    } finally {
      stderrSpy.mockRestore();
      await cleanupFixtureRoot(root);
    }
  });

  it("reports invalid extensions through the canonical package contract", async () => {
    const root = await makeFixtureRoot("entry-invalid-extensions");
    const openclaw = { extensions: "./dist/index.js" };
    try {
      await writeDeclaredPackageFixture(root, JSON.stringify({ name: "broken", openclaw }));
      const report = await runPostUpgradeProbes({ stateDir: root });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.entry_unresolved",
          plugin: "broken",
          entry: "package.json",
          message: expect.stringContaining("package.json openclaw.extensions must be an array"),
        }),
      ]);
    } finally {
      await cleanupFixtureRoot(root);
    }
  });

  it("validates legacy package records without packageJson metadata", async () => {
    await withFixtureRoot("legacy-package-json-ref", async (root) => {
      await writePluginFixture(root, {
        id: "legacy-package",
        packageJson: packageManifest("legacy-package", "./src/index.ts"),
        files: { "src/index.ts": "export default {};" },
        includePackageJsonRecord: false,
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("legacy-package");
      expect(finding?.message).toMatch(/compiled runtime output/);
    });
  });

  it("flags TypeScript source-only entries for packaged bundled plugin records", async () => {
    await withFixtureRoot("ts-packaged-bundled", async (root) => {
      await writePluginFixture(root, {
        id: "ts-packaged",
        location: "dist/extensions",
        origin: "bundled",
        packageJson: packageManifest("ts-packaged", "./src/index.ts"),
        files: { "src/index.ts": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ts-packaged");
      expect(finding?.message).toMatch(/compiled runtime output/);
    });
  });
});

describe("runPostUpgradeProbes — plugin.manifest_drift", () => {
  it("flags a plugin whose manifest hash differs from the installed index", async () => {
    await withFixtureRoot("manifest-drift", async (root) => {
      const oldManifestRaw = JSON.stringify({ id: "drifted", version: 1 });
      const oldManifestHash = crypto.createHash("sha256").update(oldManifestRaw).digest("hex");
      // Write a NEW manifest after the installed index was snapshotted.
      await writePluginFixture(root, {
        id: "drifted",
        packageJson: packageManifest("drifted"),
        files: { "dist/index.js": "export default {};" },
        manifest: { id: "drifted", version: 2 },
        manifestHash: oldManifestHash,
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.manifest_drift");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("warn");
      expect(finding?.plugin).toBe("drifted");
    });
  });
});

describe("runPostUpgradeProbes — plugin.version_drift", () => {
  beforeEach(() => {
    vi.mocked(fetchClawHubPackageDetail).mockReset();
    vi.mocked(fetchClawHubPackageDetail).mockResolvedValue({
      package: {
        name: "@openclaw/whatsapp",
        displayName: "WhatsApp",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        latestVersion: "2026.9.3",
        compatibility: { pluginApiRange: ">=2026.9.3", minGatewayVersion: ">=2026.9.3" },
      },
    });
  });

  it.each([
    // A stable host reaches the registry, finds nothing newer, and says so
    // instead of dropping the plugin from the report.
    {
      channel: "stable",
      enabled: true,
      expected: "The registry already serves 2026.9.3",
      lookup: true,
    },
    {
      channel: "extended-stable",
      enabled: true,
      expected: "No confirmed repair target",
      lookup: false,
    },
  ] as const)(
    "preserves $channel intent and persisted enablement=$enabled on a stable host",
    async ({ channel, enabled, expected, lookup }) => {
      await withFixtureRoot("clawhub-version-drift", async (root) => {
        await writePluginFixture(root, {
          id: "whatsapp",
          enabled,
          installRecord: {
            source: "clawhub",
            spec: "clawhub:@openclaw/whatsapp",
            clawhubPackage: "@openclaw/whatsapp",
            resolvedVersion: "2026.9.3",
          },
        });

        const report = await runPostUpgradeProbes({ stateDir: root, updateChannel: channel });

        expect(report.findings).toEqual(
          expected
            ? [
                expect.objectContaining({
                  code: "plugin.version_drift",
                  level: "warn",
                  plugin: "whatsapp",
                  message: expect.stringContaining(expected),
                }),
              ]
            : [],
        );
        expect(fetchClawHubPackageDetail).toHaveBeenCalledTimes(lookup ? 1 : 0);
      });
    },
  );

  it("checks an outdated official install against the upgraded core", async () => {
    await withFixtureRoot("version-drift", async (root) => {
      const id = "whatsapp";
      const version = "2026.7.1";
      await writePluginFixture(root, {
        id,
        packageJson: { name: `@openclaw/${id}`, version, openclaw: { extensions: ["./index.js"] } },
        files: { "index.js": "export default {};" },
        installRecord: {
          source: "npm",
          spec: `@openclaw/${id}@latest`,
          resolvedName: `@openclaw/${id}`,
          resolvedVersion: version,
        },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      expect(report.findings).toEqual([
        expect.objectContaining({
          code: "plugin.version_drift",
          level: "warn",
          plugin: id,
          message: expect.stringContaining(`openclaw plugins update ${id}`),
        }),
      ]);
      expect(report.findings[0]?.message).toContain(version);
      expect(report.findings[0]?.message).toContain(VERSION);
    });
  });
});

describe("runPostUpgradeProbes — manifest availability", () => {
  it("reports a missing required manifest without a hash or changing the index", async () => {
    await withFixtureRoot("manifest-availability", async (root) => {
      const id = "manifest-probe";
      const { manifestPath } = await writePluginFixture(root, { id });
      const before = await readPersistedInstalledPluginIndex({ stateDir: root });
      await fs.unlink(manifestPath);

      const report = await runPostUpgradeProbes({ stateDir: root });
      expect(report.probesRun).toContain("plugin.manifest_unavailable");
      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.manifest_unavailable",
          plugin: id,
          message: expect.stringContaining(manifestPath),
        }),
      ]);
      expect(report.findings[0]?.message).toContain("Reinstall the plugin");
      expect(report.findings[0]?.message).toContain("openclaw plugins registry --refresh");
      expect(await readPersistedInstalledPluginIndex({ stateDir: root })).toEqual(before);
    });
  });

  it.each([true, false])(
    "uses actual Claude file state after cached existence=%s",
    async (existed) => {
      await withFixtureRoot("manifest-cache-transition", async (root) => {
        const { manifestPath } = await writePluginFixture(root, {
          id: "claude-transition",
          format: "bundle",
          bundleFormat: "claude",
          manifestHash: "derived-bundle-hash",
        });
        if (!existed) {
          await fs.unlink(manifestPath);
        }
        expect(pluginCacheExistsSync(manifestPath)).toBe(existed);
        if (existed) {
          await fs.unlink(manifestPath);
        } else {
          await fs.mkdir(manifestPath);
        }
        const report = await runPostUpgradeProbes({ stateDir: root });
        expect(report.findings).toEqual(
          existed
            ? []
            : [
                expect.objectContaining({
                  level: "error",
                  code: "plugin.manifest_unavailable",
                  plugin: "claude-transition",
                  message: expect.stringContaining(manifestPath),
                }),
              ],
        );
      });
    },
  );
});
