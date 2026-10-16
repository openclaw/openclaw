// Plugin payload validation tests cover update payload checks for plugin updates.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import {
  runPluginPayloadSmokeCheck,
  runPluginPayloadSmokeCheckForManifestRecords,
} from "./payload-verification.js";

type BundleFormat = "agent" | "codex" | "claude" | "cursor";
type FormatMarkedBundleInstallRecord = PluginInstallRecord & {
  format: "bundle";
  bundleFormat?: BundleFormat;
};

describe("runPluginPayloadSmokeCheck", () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-smoke-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function checkPackage(pluginId: string, installPath: string) {
    return checkRecord(pluginId, { source: "npm", installPath });
  }

  function checkRecord(pluginId: string, record: PluginInstallRecord) {
    return runPluginPayloadSmokeCheck({ records: { [pluginId]: record }, env: {} });
  }

  async function writeJson(file: string, value: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value), "utf8");
  }

  async function writePackage(
    dir: string,
    manifest: Record<string, unknown>,
    mainContent?: string,
  ) {
    await writeJson(path.join(dir, "package.json"), manifest);
    const main = typeof manifest.main === "string" ? manifest.main : "index.js";
    if (mainContent !== undefined) {
      const target = path.join(dir, main);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, mainContent, "utf8");
    }
  }

  function expectFailure(
    result: Awaited<ReturnType<typeof checkPackage>>,
    pluginId: string,
    installPath: string,
    reason: string,
    detail: string,
  ) {
    expect(result.failures).toStrictEqual([{ pluginId, installPath, reason, detail }]);
  }

  async function writePeerPackage(dir: string) {
    await writePackage(
      dir,
      {
        name: "@openclaw/codex",
        main: "dist/index.js",
        peerDependencies: { openclaw: ">=2026.5.18-beta.1" },
      },
      "export default {};\n",
    );
  }

  async function writeBundle(params: {
    dir: string;
    format: BundleFormat;
    manifest?: unknown;
    markerOnly?: boolean;
  }) {
    await fs.mkdir(params.dir, { recursive: true });
    if (params.markerOnly) {
      await fs.mkdir(path.join(params.dir, "skills"), { recursive: true });
      return;
    }
    const manifestDir = {
      agent: "",
      codex: ".codex-plugin",
      cursor: ".cursor-plugin",
      claude: ".claude-plugin",
    }[params.format];
    const manifestRelativePath = path.join(manifestDir, "plugin.json");
    await writeJson(
      path.join(params.dir, manifestRelativePath),
      params.manifest ?? {
        ...(params.format === "agent"
          ? { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" }
          : {}),
        name: `${params.format}-bundle`,
      },
    );
    await fs.mkdir(path.join(params.dir, "skills"), { recursive: true });
  }

  function formatMarkedBundleRecord(params: {
    installPath: string;
    bundleFormat?: BundleFormat;
  }): PluginInstallRecord {
    return {
      source: "marketplace",
      format: "bundle",
      ...params,
    } satisfies FormatMarkedBundleInstallRecord;
  }

  function resolveTestHostRoot(): string {
    const hostRoot = resolveOpenClawPackageRootSync({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      cwd: process.cwd(),
    });
    expect(hostRoot).toBeTruthy();
    return hostRoot!;
  }

  async function linkOpenClawPeerToHost(dir: string): Promise<void> {
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.symlink(resolveTestHostRoot(), path.join(dir, "node_modules", "openclaw"), "junction");
  }

  async function resolveRealPath(target: string): Promise<string> {
    return await fs.realpath(target).catch(() => target);
  }

  it("checks a selected manifest root without an installed-index record", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(
      dir,
      { name: "@openclaw/codex", openclaw: { extensions: ["./index.js"] } },
      "export default {};",
    );
    const result = await runPluginPayloadSmokeCheckForManifestRecords({
      plugins: [{ id: "codex", rootDir: dir }],
      env: {},
    });

    expect(result).toEqual({ checked: ["codex"], failures: [] });
  });

  it.each([
    { dependencyField: "dependencies", expectedFailures: 0 },
    { dependencyField: "peerDependencies", expectedFailures: 1 },
  ] as const)(
    "keeps $dependencyField host checks aligned with selected-manifest ownership provenance",
    async ({ dependencyField, expectedFailures }) => {
      const dir = path.join(tmpRoot, `manifest-${dependencyField}`);
      await writePackage(
        dir,
        {
          name: "@clawemail/email",
          [dependencyField]: { openclaw: "2026.7.1" },
          openclaw: { extensions: ["./index.js"] },
        },
        "export default {};",
      );
      const staleHostDir = path.join(dir, "node_modules", "openclaw");
      await writeJson(path.join(staleHostDir, "package.json"), {
        name: "openclaw",
        version: "2026.7.1-beta.2",
      });

      const manifestResult = await runPluginPayloadSmokeCheckForManifestRecords({
        plugins: [{ id: "email", rootDir: dir }],
        env: {},
      });
      const authoritativeResult = await checkPackage("email", dir);

      expect(manifestResult.failures).toHaveLength(expectedFailures);
      expect(authoritativeResult.failures).toHaveLength(1);
      expect(authoritativeResult.failures[0]?.reason).toBe("missing-openclaw-peer-link");
    },
  );

  it("reports a failure when the package directory is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    const result = await checkPackage("brave", dir);
    expectFailure(result, "brave", dir, "missing-package-dir", `Install dir is missing: ${dir}`);
  });

  it("reports a failure when the package.json is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    await fs.mkdir(dir, { recursive: true });
    const result = await checkPackage("brave", dir);
    expectFailure(
      result,
      "brave",
      dir,
      "missing-package-json",
      `package.json is missing under ${dir}`,
    );
  });

  it.each([
    ["agent", "format"],
    ["codex", "clawhubFamily"],
  ] as const)(
    "accepts a tracked %s bundle record with no package.json via %s metadata",
    async (bundleFormat, metadataKind) => {
      const dir = path.join(tmpRoot, `${bundleFormat}-bundle`);
      await writeBundle({ dir, format: bundleFormat });
      const result = await checkRecord(
        `${bundleFormat}-bundle`,
        metadataKind === "clawhubFamily"
          ? { source: "clawhub", clawhubFamily: "bundle-plugin", installPath: dir }
          : formatMarkedBundleRecord({ installPath: dir, bundleFormat }),
      );
      expect(result).toEqual({ checked: [`${bundleFormat}-bundle`], failures: [] });
    },
  );

  it("accepts a tracked manifestless Claude bundle record with no package.json", async () => {
    const dir = path.join(tmpRoot, "manifestless-claude-bundle");
    await writeBundle({ dir, format: "claude", markerOnly: true });
    const result = await checkRecord(
      "manifestless-claude-bundle",
      formatMarkedBundleRecord({ installPath: dir }),
    );
    expect(result).toEqual({ checked: ["manifestless-claude-bundle"], failures: [] });
  });

  it("accepts a persisted marketplace bundle with an unrelated non-object package.json", async () => {
    const dir = path.join(tmpRoot, "marketplace-bundle");
    await writeBundle({ dir, format: "cursor" });
    await fs.writeFile(path.join(dir, "package.json"), "null", "utf8");
    const result = await checkRecord("marketplace-bundle", {
      source: "marketplace",
      installPath: dir,
      marketplaceName: "Local",
      marketplaceSource: "local/repo",
      marketplacePlugin: "marketplace-bundle",
    });
    expect(result).toEqual({ checked: ["marketplace-bundle"], failures: [] });
  });

  it("reports a bundle manifest failure instead of requiring package.json for bundle records", async () => {
    const dir = path.join(tmpRoot, "broken-bundle");
    await fs.mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
    const result = await checkRecord(
      "broken-bundle",
      formatMarkedBundleRecord({ installPath: dir, bundleFormat: "codex" }),
    );
    expectFailure(
      result,
      "broken-bundle",
      dir,
      "missing-bundle-manifest",
      `No supported bundle manifest or bundle marker found under ${dir}`,
    );
  });

  it("reports invalid bundle manifest when a parseable bundle manifest is not an object", async () => {
    const dir = path.join(tmpRoot, "non-object-bundle");
    await writeBundle({ dir, format: "codex", manifest: [] });
    const result = await checkRecord("non-object-bundle", {
      source: "clawhub",
      clawhubFamily: "bundle-plugin",
      installPath: dir,
    });
    expectFailure(
      result,
      "non-object-bundle",
      dir,
      "invalid-bundle-manifest",
      "Bundle manifest validation failed: plugin manifest must be an object",
    );
  });

  it("keeps dual-format bundle records on native package validation", async () => {
    const dir = path.join(tmpRoot, "dual-format-bundle");
    await writeBundle({ dir, format: "codex" });
    await writePackage(dir, {
      name: "dual-format-bundle",
      openclaw: { extensions: ["./missing-extension.js"] },
    });
    const result = await checkRecord("dual-format-bundle", {
      source: "clawhub",
      clawhubFamily: "bundle-plugin",
      installPath: dir,
    });
    expectFailure(
      result,
      "dual-format-bundle",
      dir,
      "missing-extension-entry",
      "Plugin extension entry validation failed: extension entry not found: ./missing-extension.js",
    );
  });

  it("reports a failure when `openclaw.extensions` contains invalid entries", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: ["./index.js", " "] },
      main: "main.js",
    });
    await fs.writeFile(path.join(dir, "index.js"), "export default {};\n", "utf8");
    const result = await checkPackage("brave", dir);
    expectFailure(
      result,
      "brave",
      dir,
      "missing-extension-entry",
      "Plugin extension entry validation failed: package.json openclaw.extensions[1] must be a non-empty string",
    );
  });

  it("reports only extension-entry failure for an empty extensions list even if main is missing", async () => {
    const dir = path.join(tmpRoot, "brave-empty");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: [] },
      main: "dist/index.js",
    });
    const result = await checkPackage("brave", dir);
    expectFailure(
      result,
      "brave",
      dir,
      "missing-extension-entry",
      "Plugin extension entry validation failed: package.json openclaw.extensions is empty",
    );
  });

  it("accepts a valid declared extension when an unrelated npm main is missing", async () => {
    const dir = path.join(tmpRoot, "brave");
    await writePackage(dir, {
      name: "@openclaw/brave-plugin",
      openclaw: { extensions: ["./index.js"] },
      main: "dist/index.js",
    });
    await fs.writeFile(path.join(dir, "index.js"), "export default {};\n", "utf8");
    const result = await checkPackage("brave", dir);
    expect(result.failures).toEqual([]);
  });

  it("accepts a packaged TypeScript extension entry when compiled runtime output exists", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePackage(dir, {
      name: "@openclaw/codex",
      openclaw: { extensions: ["./index.ts"] },
    });
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export default {};\n", "utf8");
    const result = await checkPackage("codex", dir);
    expect(result.failures).toEqual([]);
  });

  it("reports a failure when an openclaw peer link is missing", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePeerPackage(dir);

    const result = await checkPackage("codex", dir);

    expectFailure(
      result,
      "codex",
      dir,
      "missing-openclaw-peer-link",
      `Plugin declares peerDependency "openclaw" but peer link audit failed: missing ${path.join(
        dir,
        "node_modules",
        "openclaw",
      )}.`,
    );
  });

  it.each(["git"] as const)(
    "does not quarantine a shipped %s plugin for an unmanaged direct host dependency",
    async (source) => {
      const dir = path.join(tmpRoot, `${source}-email`);
      await writePackage(
        dir,
        {
          name: "@clawemail/email",
          main: "dist/index.js",
          dependencies: { openclaw: "2026.7.1" },
        },
        "export default {};\n",
      );
      const staleHostDir = path.join(dir, "node_modules", "openclaw");
      await writeJson(path.join(staleHostDir, "package.json"), {
        name: "openclaw",
        version: "2026.7.1-beta.2",
      });

      const result = await checkRecord("email", { source, installPath: dir });

      expect(result.failures).toEqual([]);
    },
  );

  it("reports a failure when an openclaw peer link points at the wrong package root", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePeerPackage(dir);
    const wrongHostRoot = path.join(tmpRoot, "old-openclaw");
    await fs.mkdir(wrongHostRoot, { recursive: true });
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });
    await fs.symlink(wrongHostRoot, path.join(dir, "node_modules", "openclaw"), "junction");

    const result = await checkPackage("codex", dir);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      pluginId: "codex",
      installPath: dir,
      reason: "missing-openclaw-peer-link",
    });
    expect(result.failures[0]?.detail).toContain(
      `${path.join(
        dir,
        "node_modules",
        "openclaw",
      )} points to ${await resolveRealPath(wrongHostRoot)} instead of ${await resolveRealPath(
        resolveTestHostRoot(),
      )}`,
    );
  });

  it("accepts an openclaw peer link when it resolves to the host package root", async () => {
    const dir = path.join(tmpRoot, "codex");
    await writePeerPackage(dir);
    await linkOpenClawPeerToHost(dir);

    const result = await checkPackage("codex", dir);

    expect(result.failures).toEqual([]);
  });

  it("reports a failure when `main` resolves to a directory rather than a file", async () => {
    const dir = path.join(tmpRoot, "dir-main");
    await writePackage(dir, { name: "dir-main", main: "lib" });
    await fs.mkdir(path.join(dir, "lib"), { recursive: true });
    const result = await checkPackage("x", dir);
    expectFailure(
      result,
      "x",
      dir,
      "missing-main-entry",
      `Plugin main entry "lib" not found at ${path.join(dir, "lib")}`,
    );
  });

  it.each([
    [
      "not-json",
      process.versions.bun
        ? 'JSON Parse error: Unexpected identifier "not"'
        : "Unexpected token 'o', \"not-json\" is not valid JSON",
    ],
    ["null", "package.json must be an object"],
  ])(
    "reports invalid package.json %s and continues checking later plugins",
    async (content, error) => {
      const dir = path.join(tmpRoot, "broken");
      const laterDir = path.join(tmpRoot, "later");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "package.json"), content, "utf8");
      await writePackage(laterDir, { name: "later", main: "missing.js" });

      const result = await runPluginPayloadSmokeCheck({
        records: {
          broken: { source: "npm", installPath: dir },
          later: { source: "npm", installPath: laterDir },
        },
        env: {},
      });

      expect(result.checked).toEqual(["broken", "later"]);
      expect(result.failures).toStrictEqual([
        {
          pluginId: "broken",
          installPath: dir,
          reason: "invalid-package-json",
          detail: `Could not parse package.json: ${error}`,
        },
        {
          pluginId: "later",
          installPath: laterDir,
          reason: "missing-main-entry",
          detail: `Plugin main entry "missing.js" not found at ${path.join(laterDir, "missing.js")}`,
        },
      ]);
    },
  );

  it.each(["EACCES"])("classifies a %s package.json read failure as unreadable", async (code) => {
    const dir = path.join(tmpRoot, "unreadable");
    const packageJsonPath = path.join(dir, "package.json");
    await writePackage(dir, { name: "unreadable" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(
      Object.assign(new Error(`${code}: could not read ${packageJsonPath}`), { code }),
    );

    const result = await checkPackage("unreadable", dir);

    expectFailure(
      result,
      "unreadable",
      dir,
      "unreadable-package-json",
      `Could not read package.json at ${packageJsonPath}: ${code}: could not read ${packageJsonPath}`,
    );
  });

  it("reports a failure when an install record is missing installPath", async () => {
    const result = await runPluginPayloadSmokeCheck({
      records: {
        discord: { source: "npm" } as unknown as { source: "npm"; installPath?: string },
      },
      env: {},
    });
    expect(result.checked).toEqual(["discord"]);
    expect(result.failures).toEqual([
      {
        pluginId: "discord",
        reason: "missing-install-path",
        detail: "Install path is missing from the plugin install record.",
      },
    ]);
  });

  it("only checks records whose source is package-tracked (npm/clawhub/git/marketplace)", async () => {
    const dir = path.join(tmpRoot, "tracked");
    await writePackage(dir, { name: "tracked" }, "module.exports = {};");
    const records = {
      bundled: { source: "bundled", installPath: dir } as never,
      npm: { source: "npm" as const, installPath: dir },
    };
    const result = await runPluginPayloadSmokeCheck({
      records,
      env: {},
    });
    expect(result.checked).toEqual(["npm"]);
  });
});
