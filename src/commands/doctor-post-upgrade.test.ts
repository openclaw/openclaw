import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { fetchClawHubPackageDetail } from "../infra/clawhub-packages.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import {
  readPersistedInstalledPluginIndex,
  resolveInstalledPluginIndexStorePath,
} from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginIndex } from "../plugins/installed-plugin-index.js";
import { pluginCacheExistsSync } from "../plugins/plugin-cache-files.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
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

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-post-upgrade-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetLogger();
  const databasePath = resolveInstalledPluginIndexStorePath({ stateDir: root });
  clearPluginMetadataLifecycleCaches();
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  // Physical admissions outlive handles; retire this fixture before deleting its files.
  retireSqliteDatabaseAdmissionForPath(databasePath);
  await fs.rm(root, { recursive: true, force: true });
  expect(captureSqliteDatabaseAdmissions().map(({ location }) => location)).not.toContain(
    databasePath,
  );
});

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

async function writePluginFixture(params: {
  id: string;
  location?: string;
  packageJson?: unknown;
  packageJsonRaw?: string;
  files?: Record<string, string>;
  origin?: InstalledPluginIndex["plugins"][number]["origin"];
  includePackageJsonRecord?: boolean;
  manifest?: Record<string, unknown> | false;
  manifestHash?: string;
  format?: InstalledPluginIndex["plugins"][number]["format"];
  bundleFormat?: InstalledPluginIndex["plugins"][number]["bundleFormat"];
  installRecord?: PluginInstallRecord;
  record?: Partial<InstalledPluginIndex["plugins"][number]>;
}) {
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
          enabled: true,
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
          ...params.record,
        },
      ],
      params.installRecord ? { [params.id]: params.installRecord } : {},
    ),
    { stateDir: root },
  );
  return { manifestPath };
}

function expectFinding(
  report: Awaited<ReturnType<typeof runPostUpgradeProbes>>,
  finding: Record<string, unknown>,
) {
  expect(report.findings).toEqual([expect.objectContaining(finding)]);
}

function packageManifest(name: string, entry = "./dist/index.js") {
  return { name, version: "0.0.1", type: "module", openclaw: { extensions: [entry] } };
}

it("returns a structured finding when the installed plugin index is missing", async () => {
  const report = await runPostUpgradeProbes({ stateDir: root });

  expect(report.probesRun).toContain("plugin.index_unavailable");
  expectFinding(report, { level: "error", code: "plugin.index_unavailable" });
});

it("reports unreadable plugin packages as structured errors without losing JSON console diagnostics", async () => {
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
  await writePluginFixture({
    id: "broken",
    manifest: false,
    record: { packageJson: { path: "missing-package.json", hash: "package-hash" } },
  });
  setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });

  const report = await runPostUpgradeProbes({ stateDir: root });

  expectFinding(report, {
    level: "error",
    code: "plugin.entry_unresolved",
    plugin: "broken",
    entry: "missing-package.json",
    message: expect.stringContaining("openclaw plugins registry --refresh"),
  });
  const line = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
  expect(JSON.parse(line)).toMatchObject({
    level: "warn",
    message: expect.stringContaining("could not read package.json for broken"),
  });
});

it.each([
  ["non-object manifest", "null", "package.json must contain a JSON object"],
  [
    "invalid extensions",
    JSON.stringify({ name: "broken", openclaw: { extensions: "./dist/index.js" } }),
    "package.json openclaw.extensions must be an array",
  ],
])("rejects %s", async (_name, packageJsonRaw, message) => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await writePluginFixture({ id: "broken", packageJsonRaw, manifest: false });
  expectFinding(await runPostUpgradeProbes({ stateDir: root }), {
    level: "error",
    code: "plugin.entry_unresolved",
    plugin: "broken",
    entry: "package.json",
    message: expect.stringContaining(message),
  });
});

it.each([
  { id: "legacy-package", includePackageJsonRecord: false },
  { id: "ts-packaged", location: "dist/extensions", origin: "bundled" as const },
])("rejects source-only entries for $id", async (params) => {
  await writePluginFixture({
    ...params,
    packageJson: packageManifest(params.id, "./src/index.ts"),
    files: { "src/index.ts": "export default {};" },
  });
  const report = await runPostUpgradeProbes({ stateDir: root });
  expect(report.findings.find((f) => f.code === "plugin.entry_unresolved")).toMatchObject({
    level: "error",
    plugin: params.id,
    message: expect.stringMatching(/compiled runtime output/),
  });
});

it("flags a plugin whose manifest hash differs from the installed index", async () => {
  const oldManifestHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ id: "drifted", version: 1 }))
    .digest("hex");
  await writePluginFixture({
    id: "drifted",
    packageJson: packageManifest("drifted"),
    files: { "dist/index.js": "export default {};" },
    manifest: { id: "drifted", version: 2 },
    manifestHash: oldManifestHash,
  });

  const report = await runPostUpgradeProbes({ stateDir: root });
  const finding = report.findings.find((f) => f.code === "plugin.manifest_drift");
  expect(finding).toMatchObject({ level: "warn", plugin: "drifted" });
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
    { channel: "stable", expected: "The registry already serves 2026.9.3", lookup: true },
    { channel: "extended-stable", expected: "No confirmed repair target", lookup: false },
  ] as const)(
    "preserves $channel intent and persisted enablement on a stable host",
    async ({ channel, expected, lookup }) => {
      await writePluginFixture({
        id: "whatsapp",
        installRecord: {
          source: "clawhub",
          spec: "clawhub:@openclaw/whatsapp",
          clawhubPackage: "@openclaw/whatsapp",
          resolvedVersion: "2026.9.3",
        },
      });

      const report = await runPostUpgradeProbes({ stateDir: root, updateChannel: channel });

      expectFinding(report, {
        code: "plugin.version_drift",
        level: "warn",
        plugin: "whatsapp",
        message: expect.stringContaining(expected),
      });
      expect(fetchClawHubPackageDetail).toHaveBeenCalledTimes(lookup ? 1 : 0);
    },
  );

  it("checks an outdated official install against the upgraded core", async () => {
    const id = "whatsapp";
    const version = "2026.7.1";
    await writePluginFixture({
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
    expectFinding(report, {
      code: "plugin.version_drift",
      level: "warn",
      plugin: id,
      message: expect.stringContaining(`openclaw plugins update ${id}`),
    });
    expect(report.findings[0]?.message).toContain(version);
    expect(report.findings[0]?.message).toContain(VERSION);
  });
});

it("reports a missing required manifest without a hash or changing the index", async () => {
  const id = "manifest-probe";
  const { manifestPath } = await writePluginFixture({ id });
  const before = await readPersistedInstalledPluginIndex({ stateDir: root });
  await fs.unlink(manifestPath);

  const report = await runPostUpgradeProbes({ stateDir: root });
  expect(report.probesRun).toContain("plugin.manifest_unavailable");
  expectFinding(report, {
    level: "error",
    code: "plugin.manifest_unavailable",
    plugin: id,
    message: expect.stringContaining(manifestPath),
  });
  expect(report.findings[0]?.message).toContain("Reinstall the plugin");
  expect(report.findings[0]?.message).toContain("openclaw plugins registry --refresh");
  expect(await readPersistedInstalledPluginIndex({ stateDir: root })).toEqual(before);
});

it.each([true, false])(
  "uses actual Claude file state after cached existence=%s",
  async (existed) => {
    const { manifestPath } = await writePluginFixture({
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
  },
);
