import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
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
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { runPostUpgradeProbes } from "./doctor-post-upgrade.js";

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

function writeRawIndexFixture(root: string, valueJson: string): void {
  // Keep malformed JSON bytes intact so the canonical row parser owns rejection.
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        `INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms)
         VALUES ('plugins.installedIndex', ?, 1)`,
      ).run(valueJson);
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: root } },
  );
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

  it("returns a structured finding when the installed plugin index is malformed", async () => {
    await withFixtureRoot("index-malformed", async (root) => {
      writeRawIndexFixture(root, "{ not json");

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

  it("returns a structured finding when an installed plugin record is malformed", async () => {
    await withFixtureRoot("record-malformed", async (root) => {
      writeRawIndexFixture(
        root,
        JSON.stringify({ revision: 1, index: { ...createIndex([]), plugins: [{}] } }),
      );

      const report = await runPostUpgradeProbes({ stateDir: root });

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

  it("reports malformed declared plugin packages as entry resolution errors", async () => {
    const root = await makeFixtureRoot("entry-malformed-package");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    try {
      await writeDeclaredPackageFixture(root, "{ not json");
      const report = await runPostUpgradeProbes({ stateDir: root });

      expect(report.findings).toEqual([
        expect.objectContaining({
          level: "error",
          code: "plugin.entry_unresolved",
          plugin: "broken",
          entry: "package.json",
          message: expect.stringContaining("openclaw plugins registry --refresh"),
        }),
      ]);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      await cleanupFixtureRoot(root);
    }
  });

  it.each([
    { label: "null", packageJson: null },
    { label: "array", packageJson: [] },
    { label: "string", packageJson: "not a package" },
  ])("rejects a $label declared package manifest", async ({ label, packageJson }) => {
    const root = await makeFixtureRoot(`entry-non-object-${label}`);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true as unknown as ReturnType<typeof process.stderr.write>);
    try {
      await writeDeclaredPackageFixture(root, JSON.stringify(packageJson));
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

  it.each([
    {
      label: "non-object metadata",
      openclaw: "invalid",
      reason: "package.json openclaw must be an object",
    },
    {
      label: "non-array entries",
      openclaw: { extensions: "./dist/index.js" },
      reason: "package.json openclaw.extensions must be an array",
    },
    {
      label: "blank entries",
      openclaw: { extensions: ["  "] },
      reason: "package.json openclaw.extensions[0] must be a non-empty string",
    },
    {
      label: "non-string entries",
      openclaw: { extensions: [42] },
      reason: "package.json openclaw.extensions[0] must be a non-empty string",
    },
  ])(
    "reports $label through the canonical package contract",
    async ({ label, openclaw, reason }) => {
      const root = await makeFixtureRoot(`entry-invalid-${label.replaceAll(" ", "-")}`);
      try {
        await writeDeclaredPackageFixture(root, JSON.stringify({ name: "broken", openclaw }));
        const report = await runPostUpgradeProbes({ stateDir: root });

        expect(report.findings).toEqual([
          expect.objectContaining({
            level: "error",
            code: "plugin.entry_unresolved",
            plugin: "broken",
            entry: "package.json",
            message: expect.stringContaining(reason),
          }),
        ]);
      } finally {
        await cleanupFixtureRoot(root);
      }
    },
  );

  it("reads the canonical SQLite plugin index by default", async () => {
    await withFixtureRoot("entry-sqlite", async (root) => {
      await writePluginFixture(root, {
        id: "sqlite-ghost",
        packageJson: {
          name: "sqlite-ghost",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        },
        manifestHash: "manifest-hash",
      });

      const report = await runPostUpgradeProbes({ stateDir: root });

      expect(report.findings).not.toContainEqual(
        expect.objectContaining({ code: "plugin.index_unavailable" }),
      );
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.plugin).toBe("sqlite-ghost");
    });
  });

  it("flags an enabled plugin whose declared entry does not exist on disk", async () => {
    await withFixtureRoot("entry-unresolved", async (root) => {
      await writePluginFixture(root, {
        id: "ghost",
        packageJson: {
          name: "ghost",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ghost");
      expect(finding?.entry).toBe("./dist/index.js");
    });
  });

  it("emits no entry_unresolved findings when the entry resolves", async () => {
    await withFixtureRoot("entry-ok", async (root) => {
      await writePluginFixture(root, {
        id: "good",
        packageJson: {
          name: "good",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        },
        files: { "dist/index.js": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });

  it("skips package entry validation for non-package registry records", async () => {
    await withFixtureRoot("no-package-json-ref", async (root) => {
      await writePluginFixture(root, {
        id: "runtime-only",
        location: "dist/extensions",
        origin: "bundled",
        files: { "index.js": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      expect(report.findings).toHaveLength(0);
    });
  });

  it("validates legacy package records without packageJson metadata", async () => {
    await withFixtureRoot("legacy-package-json-ref", async (root) => {
      await writePluginFixture(root, {
        id: "legacy-package",
        packageJson: {
          name: "legacy-package",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
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

  it("flags an entry that escapes the plugin package directory", async () => {
    await withFixtureRoot("entry-escape", async (root) => {
      // Create a sibling file outside the plugin root that the entry resolves to.
      const outsideDir = path.join(root, "outside");
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "leak.js"), "export default {};", "utf-8");
      await writePluginFixture(root, {
        id: "escape",
        packageJson: {
          name: "escape",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["../outside/leak.js"] },
        },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("escape");
      expect(finding?.message).toMatch(/escapes plugin directory/);
    });
  });

  it("accepts a TypeScript source entry that ships a compiled dist peer", async () => {
    await withFixtureRoot("ts-with-dist", async (root) => {
      // No explicit runtimeExtensions; the resolver should infer dist/index.js.
      await writePluginFixture(root, {
        id: "ts-dist",
        packageJson: {
          name: "ts-dist",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: {
          "src/index.ts": "export default {};",
          "dist/index.js": "export default {};",
        },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });

  it("flags a TypeScript source-only entry with no compiled output", async () => {
    await withFixtureRoot("ts-source-only", async (root) => {
      // Source exists, no dist peer — installed plugins must ship compiled JS.
      await writePluginFixture(root, {
        id: "ts-only",
        packageJson: {
          name: "ts-only",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: { "src/index.ts": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ts-only");
      expect(finding?.message).toMatch(/compiled runtime output/);
    });
  });

  it("allows TypeScript source-only entries for source checkout plugin records", async () => {
    await withFixtureRoot("ts-source-checkout", async (root) => {
      await fs.mkdir(path.join(root, ".git"), { recursive: true });
      await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf-8");
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await writePluginFixture(root, {
        id: "ts-source",
        location: "extensions",
        origin: "bundled",
        packageJson: {
          name: "ts-source",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: { "src/index.ts": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });

  it("flags TypeScript source-only entries for packaged bundled plugin records", async () => {
    await withFixtureRoot("ts-packaged-bundled", async (root) => {
      await writePluginFixture(root, {
        id: "ts-packaged",
        location: "dist/extensions",
        origin: "bundled",
        packageJson: {
          name: "ts-packaged",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./src/index.ts"] },
        },
        files: { "src/index.ts": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("ts-packaged");
      expect(finding?.message).toMatch(/compiled runtime output/);
    });
  });

  it("flags a runtimeExtensions length mismatch", async () => {
    await withFixtureRoot("runtime-len-mismatch", async (root) => {
      await writePluginFixture(root, {
        id: "len-mismatch",
        packageJson: {
          name: "len-mismatch",
          version: "0.0.1",
          type: "module",
          openclaw: {
            extensions: ["./dist/a.js", "./dist/b.js"],
            runtimeExtensions: ["./dist/a.js"],
          },
        },
        files: {
          "dist/a.js": "export default {};",
          "dist/b.js": "export default {};",
        },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      const finding = report.findings.find((f) => f.code === "plugin.entry_unresolved");
      expect(finding).toBeDefined();
      expect(finding?.level).toBe("error");
      expect(finding?.plugin).toBe("len-mismatch");
      expect(finding?.message).toMatch(/runtimeExtensions length/);
    });
  });

  it("does not flag entry_unresolved when runtimeExtensions exists even if source entry is missing", async () => {
    await withFixtureRoot("runtime-extensions", async (root) => {
      // Source entry (./src/index.ts) does NOT exist
      // But runtime entry (./dist/index.js) DOES exist
      await writePluginFixture(root, {
        id: "runtime-only",
        packageJson: {
          name: "runtime-only",
          version: "0.0.1",
          type: "module",
          openclaw: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: { "dist/index.js": "export default {};" },
      });

      const report = await runPostUpgradeProbes({ stateDir: root });
      expect(report.findings.filter((f) => f.code === "plugin.entry_unresolved")).toHaveLength(0);
    });
  });
});

describe("runPostUpgradeProbes — plugin.manifest_drift", () => {
  it("flags a plugin whose manifest hash differs from installs.json", async () => {
    await withFixtureRoot("manifest-drift", async (root) => {
      const oldManifestRaw = JSON.stringify({ id: "drifted", version: 1 });
      const oldManifestHash = crypto.createHash("sha256").update(oldManifestRaw).digest("hex");
      // Write a NEW manifest after the installed index was snapshotted.
      await writePluginFixture(root, {
        id: "drifted",
        packageJson: {
          name: "drifted",
          version: "0.0.1",
          type: "module",
          openclaw: { extensions: ["./dist/index.js"] },
        },
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
  it.each([
    {
      label: "outdated official install",
      id: "whatsapp",
      version: "2026.7.1",
      enabled: true,
      drift: true,
    },
    {
      label: "matching official install",
      id: "whatsapp",
      version: VERSION,
      enabled: true,
      drift: false,
    },
    {
      label: "disabled official install",
      id: "whatsapp",
      version: "2026.7.1",
      enabled: false,
      drift: false,
    },
    { label: "community install", id: "community", version: "1.2.3", enabled: true, drift: false },
  ])("checks $label against the upgraded core", async ({ id, version, enabled, drift }) => {
    await withFixtureRoot("version-drift", async (root) => {
      await writePluginFixture(root, {
        id,
        enabled,
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
      expect(report.findings).toEqual(
        drift
          ? [
              expect.objectContaining({
                code: "plugin.version_drift",
                level: "warn",
                plugin: id,
                message: expect.stringContaining(`openclaw plugins update ${id}`),
              }),
            ]
          : [],
      );
      if (drift) {
        expect(report.findings[0]?.message).toContain(version);
        expect(report.findings[0]?.message).toContain(VERSION);
      }
    });
  });
});

describe("runPostUpgradeProbes — manifest availability", () => {
  it.for([
    { label: "missing required", kind: "missing", claude: false, enabled: true, error: true },
    { label: "directory required", kind: "directory", claude: false, enabled: true, error: true },
    { label: "unreadable required", kind: "unreadable", claude: false, enabled: true, error: true },
    { label: "missing disabled", kind: "missing", claude: false, enabled: false, error: false },
    { label: "missing Claude", kind: "missing", claude: true, enabled: true, error: false },
    { label: "directory Claude", kind: "directory", claude: true, enabled: true, error: true },
    { label: "matching required", kind: "matching", claude: false, enabled: true, error: false },
    {
      label: "missing required without hash",
      kind: "missing",
      claude: false,
      enabled: true,
      error: true,
      emptyHash: true,
    },
    {
      label: "directory required without hash",
      kind: "directory",
      claude: false,
      enabled: true,
      error: true,
      emptyHash: true,
    },
    {
      label: "unreadable required without hash",
      kind: "unreadable",
      claude: false,
      enabled: true,
      error: true,
      emptyHash: true,
    },
    {
      label: "matching required without hash",
      kind: "matching",
      claude: false,
      enabled: true,
      error: false,
      emptyHash: true,
    },
    {
      label: "missing disabled without hash",
      kind: "missing",
      claude: false,
      enabled: false,
      error: false,
      emptyHash: true,
    },
    {
      label: "missing Claude without hash",
      kind: "missing",
      claude: true,
      enabled: true,
      error: false,
      emptyHash: true,
    },
    {
      label: "directory Claude without hash",
      kind: "directory",
      claude: true,
      enabled: true,
      error: true,
      emptyHash: true,
    },
    {
      label: "matching Claude without hash",
      kind: "matching",
      claude: true,
      enabled: true,
      error: false,
      emptyHash: true,
    },
  ])(
    "reports $label manifests without changing the index",
    async ({ kind, claude, enabled, error, emptyHash }, context) => {
      // Windows chmod and privileged users cannot make a file unreadable this way.
      if (kind === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0)) {
        context.skip();
      }
      await withFixtureRoot("manifest-availability", async (root) => {
        const id = "manifest-probe";
        const raw = JSON.stringify({ id });
        const { manifestPath } = await writePluginFixture(root, {
          id,
          enabled,
          manifestHash: emptyHash ? "" : crypto.createHash("sha256").update(raw).digest("hex"),
          ...(claude ? { format: "bundle", bundleFormat: "claude" } : {}),
        });
        const before = await readPersistedInstalledPluginIndex({ stateDir: root });
        if (kind === "missing" || kind === "directory") {
          await fs.unlink(manifestPath);
        }
        if (kind === "directory") {
          await fs.mkdir(manifestPath);
        }
        if (kind === "unreadable") {
          await fs.chmod(manifestPath, 0);
        }
        try {
          const report = await runPostUpgradeProbes({ stateDir: root });
          expect(report.probesRun).toContain("plugin.manifest_unavailable");
          expect(report.findings).toEqual(
            error
              ? [
                  expect.objectContaining({
                    level: "error",
                    code: "plugin.manifest_unavailable",
                    plugin: id,
                    message: expect.stringContaining(manifestPath),
                  }),
                ]
              : [],
          );
          if (error) {
            expect(report.findings[0]?.message).toContain("Reinstall the plugin");
            expect(report.findings[0]?.message).toContain("openclaw plugins registry --refresh");
          }
          expect(await readPersistedInstalledPluginIndex({ stateDir: root })).toEqual(before);
        } finally {
          if (kind === "unreadable") {
            await fs.chmod(manifestPath, 0o600);
          }
        }
      });
    },
  );

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
