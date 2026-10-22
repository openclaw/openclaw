import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import { getChannelPluginCatalogEntry, listRawChannelPluginCatalogEntries } from "../../catalog.js";
import type { ChannelMeta as Meta } from "../../channel-meta.types.js";
const tempDir = () =>
  fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-catalog-"));
const writeJson = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
const lookup = (
  id: string,
  options: Parameters<typeof listRawChannelPluginCatalogEntries>[0] = {},
) => listRawChannelPluginCatalogEntries(options).find((entry) => entry.id === id);

function catalogEntry(
  id: string,
  name: string | null = `@openclaw/${id}`,
  meta: Partial<Meta> = {},
  install: object = { npmSpec: name },
) {
  return {
    name: name ?? undefined,
    openclaw: {
      channel: { id, label: id, ...meta },
      install,
    },
  };
}
function catalogFile(entry: object, dir = tempDir(), rich = false) {
  const file = path.join(dir, "catalog.json");
  writeJson(file, {
    ...(rich
      ? {
          $schema: "./manifest.schema.json",
          schemaVersion: 1,
          description:
            "Extension manifest. Declares plugin packages that OpenClaw can discover during onboarding and install on demand via `openclaw plugins install`.",
        }
      : {}),
    entries: [entry],
  });
  return file;
}
function writePlugin(
  dir: string,
  entry: ReturnType<typeof catalogEntry>,
  id: string,
  channels?: string[],
) {
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "package.json"), {
    ...entry,
    openclaw: { ...entry.openclaw, extensions: ["./index.js"] },
  });
  writeJson(path.join(dir, "openclaw.plugin.json"), { id, channels, configSchema: {} });
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {}", "utf8");
}

export function describeChannelCatalogEntryContract(params: {
  channelId: string;
  npmSpec: string;
  alias?: string;
}) {
  it(`${params.channelId} channel catalog contract keeps the shipped catalog entry aligned`, () => {
    const entry = getChannelPluginCatalogEntry(params.channelId);
    expect(entry?.install.npmSpec).toBe(params.npmSpec);
    if (params.alias) {
      expect(entry?.meta.aliases).toContain(params.alias);
    }
  });
}
export function describeBundledMetadataOnlyChannelCatalogContract(params: {
  pluginId: string;
  packageName: string;
  npmSpec: string;
  meta: Meta;
  defaultChoice?: string;
}) {
  it(`${params.pluginId} bundled metadata-only channel catalog contract includes the bundled metadata-only channel entry when the runtime entrypoint is omitted`, () => {
    const workspaceDir = tempDir();
    writeJson(path.join(workspaceDir, "package.json"), { name: "openclaw" });
    writePlugin(
      path.join(workspaceDir, ".openclaw", "extensions", params.pluginId),
      catalogEntry(params.meta.id, params.packageName, params.meta, {
        npmSpec: params.npmSpec,
        defaultChoice: params.defaultChoice,
      }),
      params.pluginId,
      [params.meta.id],
    );
    expect(
      lookup(params.meta.id, {
        workspaceDir,
        env: { ...process.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      }),
    ).toMatchObject({ install: { npmSpec: params.npmSpec }, pluginId: params.pluginId });
  });
}
export function describeOfficialFallbackChannelCatalogContract(params: {
  channelId: string;
  npmSpec: string;
  meta: Meta;
  packageName: string;
  externalNpmSpec: string;
  externalLabel: string;
}) {
  describe(`${params.channelId} official fallback channel catalog contract`, () => {
    const find = (options: Parameters<typeof lookup>[1]) =>
      lookup(params.channelId, {
        env: {
          ...process.env,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        },
        ...options,
      });
    it.each([
      ["includes shipped official channel catalog entries when bundled metadata is omitted", false],
      ["lets external catalogs override shipped fallback channel metadata", true],
    ] as const)("%s", (_name, external) => {
      const dir = tempDir();
      const override = catalogEntry(params.channelId, params.externalNpmSpec, {
        ...params.meta,
        label: params.externalLabel,
        selectionLabel: params.externalLabel,
        blurb: "external override",
      });
      const entry = find({
        catalogPaths: external ? [catalogFile(override, dir)] : undefined,
        officialCatalogPaths: [path.join(dir, "channel-catalog.json")],
      });
      expect(entry?.install.npmSpec).toBe(external ? params.externalNpmSpec : params.npmSpec);
      if (external) {
        expect(entry?.meta.label).toBe(params.externalLabel);
      }
      expect(entry?.pluginId).toBeUndefined();
      expect(entry?.trustedSourceLinkedOfficialInstall).toBe(external ? undefined : true);
    });
    it("surfaces package-name drift in external channel catalog install metadata", () => {
      const entry = find({
        catalogPaths: [
          catalogFile(
            catalogEntry(params.channelId, params.packageName, params.meta, {
              npmSpec: `${params.packageName}-fork@1.2.3`,
              expectedIntegrity: "sha512-drifted",
            }),
          ),
        ],
        officialCatalogPaths: [],
      });
      expect(entry?.installSource?.npm).toMatchObject({
        packageName: `${params.packageName}-fork`,
        expectedPackageName: params.packageName,
      });
      expect(entry?.installSource?.warnings).toEqual(["npm-spec-package-name-mismatch"]);
    });
  });
}

const richMeta = {
  label: "WeCom",
  selectionLabel: "WeCom (企业微信)",
  detailLabel: "WeCom",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "企业微信 (WeCom) bot & conversation channel.",
};
function expectRichCatalog(
  id: string,
  packageName: string | null,
  install: object,
  installSource: object,
) {
  const entry = {
    ...catalogEntry(id, packageName, { ...richMeta, aliases: ["chat"], order: 45 }, install),
    source: "external",
    kind: "channel",
  };
  expect(lookup(id, { catalogPaths: [catalogFile(entry, tempDir(), true)] })).toMatchObject({
    id,
    meta: richMeta,
    install,
    installSource,
  });
}

export function describeChannelPluginCatalogEntriesContract() {
  describe("channel plugin catalog entries contract", () => {
    it("keeps discovered plugins ahead of external catalog overrides", () => {
      const stateDir = tempDir();
      writePlugin(
        path.join(stateDir, "extensions", "demo-channel-plugin"),
        catalogEntry("demo-channel", "@vendor/demo-channel-plugin", {
          label: "Demo Channel Runtime",
        }),
        "@vendor/demo-channel-runtime",
      );
      const catalogPath = catalogFile(
        catalogEntry("demo-channel", "@vendor/demo-channel-catalog", {
          label: "Demo Channel Catalog",
        }),
        stateDir,
      );
      expect(
        lookup("demo-channel", {
          catalogPaths: [catalogPath],
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            CLAWDBOT_STATE_DIR: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
          },
        }),
      ).toMatchObject({
        install: { npmSpec: "@vendor/demo-channel-plugin" },
        meta: { label: "Demo Channel Runtime" },
        pluginId: "@vendor/demo-channel-runtime",
      });
    });
    it("pins bare external prerelease package specs to the entry version", () => {
      const catalogPath = catalogFile({
        ...catalogEntry("prerelease-demo", "@openclaw/prerelease-demo-channel", {
          label: "Prerelease Demo",
        }),
        version: "2026.5.3-beta.1",
      });
      expect(lookup("prerelease-demo", { catalogPaths: [catalogPath] })).toMatchObject({
        install: { npmSpec: "@openclaw/prerelease-demo-channel@2026.5.3-beta.1" },
        installSource: {
          npm: {
            spec: "@openclaw/prerelease-demo-channel@2026.5.3-beta.1",
            packageName: "@openclaw/prerelease-demo-channel",
            selector: "2026.5.3-beta.1",
            selectorKind: "exact-version",
            exactVersion: true,
          },
        },
      });
    });
    it.each([
      ["wecom", "@wecom/wecom-openclaw-plugin", "1.2.3", "sha512-wecom"],
      ["openclaw-plugin-yuanbao", "openclaw-plugin-yuanbao", "1.0.0", "sha512-yuanbao"],
    ])(
      "accepts rich external manifest entries for %s with pinned npm metadata",
      (id, packageName, version, expectedIntegrity) => {
        const npmSpec = `${packageName}@${version}`;
        expectRichCatalog(
          id,
          packageName,
          {
            npmSpec,
            defaultChoice: "npm",
            minHostVersion: ">=2026.4.10",
            expectedIntegrity,
          },
          {
            defaultChoice: "npm",
            npm: {
              spec: npmSpec,
              packageName,
              selector: version,
              selectorKind: "exact-version",
              exactVersion: true,
              expectedIntegrity,
              pinState: "exact-with-integrity",
            },
            warnings: [],
          },
        );
      },
    );
    it("accepts external manifest entries with ClawHub-only install metadata", () => {
      const spec = "clawhub:openclaw/clawhub-chat@2026.5.2";
      expectRichCatalog(
        "clawhub-chat",
        null,
        {
          clawhubSpec: spec,
          defaultChoice: "clawhub",
          minHostVersion: ">=2026.5.1",
        },
        {
          defaultChoice: "clawhub",
          clawhub: {
            spec,
            packageName: "openclaw/clawhub-chat",
            version: "2026.5.2",
            exactVersion: true,
          },
          warnings: [],
        },
      );
    });
  });
}
export function describeChannelPluginCatalogPathResolutionContract() {
  describe("channel plugin catalog path resolution contract", () => {
    it.each([
      {
        name: "uses the provided env for external catalog path resolution",
        relativePath: "catalog.json",
        id: "env-demo-channel",
        meta: { order: 1000 },
        env: (dir: string) => ({
          OPENCLAW_PLUGIN_CATALOG_PATHS: "~/catalog.json",
          OPENCLAW_HOME: dir,
          HOME: dir,
        }),
      },
      {
        name: "uses the provided env for default catalog paths",
        relativePath: "plugins/catalog.json",
        id: "default-env-demo",
        meta: {},
        env: (dir: string) => ({ OPENCLAW_STATE_DIR: dir }),
      },
    ])("$name", ({ relativePath, id, meta, env }) => {
      const dir = tempDir();
      const targetDir = path.dirname(path.join(dir, relativePath));
      fs.mkdirSync(targetDir, { recursive: true });
      catalogFile(catalogEntry(id, undefined, meta), targetDir);
      expect(
        listRawChannelPluginCatalogEntries({ env: { ...process.env, ...env(dir) } }).map(
          (entry) => entry.id,
        ),
      ).toContain(id);
    });
  });
}
