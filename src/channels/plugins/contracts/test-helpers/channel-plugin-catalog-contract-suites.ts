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
const richMeta = {
  label: "WeCom",
  selectionLabel: "WeCom (企业微信)",
  detailLabel: "WeCom",
  docsPath: "/channels/wecom",
  docsLabel: "wecom",
  blurb: "企业微信 (WeCom) bot & conversation channel.",
};
function catalogEntry(
  id: string,
  name: string | null = `@openclaw/${id}`,
  meta: Partial<Meta> = {},
  install: object = { npmSpec: name },
) {
  return { name: name ?? undefined, openclaw: { channel: { id, label: id, ...meta }, install } };
}
function catalogFile(entry: object, dir = tempDir(), rich = false) {
  const file = path.join(dir, "catalog.json");
  writeJson(file, {
    ...(rich
      ? {
          $schema: "./manifest.schema.json",
          schemaVersion: 1,
          description: "External channel manifest",
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
  it(`${params.pluginId} includes bundled metadata when the runtime entrypoint is omitted`, () => {
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
    it.each([false, true])("external override=%s preserves install provenance", (external) => {
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
export function describeChannelPluginCatalogEntriesContract() {
  describe("channel plugin catalog entries contract", () => {
    it("keeps discovered plugins ahead of external catalog overrides", () => {
      const stateDir = tempDir();
      const entry = (source: string) =>
        catalogEntry("demo-channel", `@vendor/demo-channel-${source}`, {
          label: `Demo Channel ${source}`,
        });
      writePlugin(
        path.join(stateDir, "extensions", "demo-channel-plugin"),
        entry("plugin"),
        "@vendor/demo-channel-runtime",
      );
      expect(
        lookup("demo-channel", {
          catalogPaths: [catalogFile(entry("catalog"), stateDir)],
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            CLAWDBOT_STATE_DIR: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
          },
        }),
      ).toMatchObject({
        install: { npmSpec: "@vendor/demo-channel-plugin" },
        meta: { label: "Demo Channel plugin" },
        pluginId: "@vendor/demo-channel-runtime",
      });
    });
    it.each(["@openclaw/prerelease-demo-channel", "openclaw-plugin-yuanbao"])(
      "preserves rich npm metadata and pins the bare %s prerelease spec",
      (name) => {
        const version = "2026.5.3-beta.1";
        const metadata = {
          defaultChoice: "npm",
          minHostVersion: ">=2026.5.1",
          expectedIntegrity: "sha512-demo",
        };
        const file = catalogFile(
          {
            ...catalogEntry(
              "prerelease-demo",
              name,
              { ...richMeta, aliases: ["chat"], order: 45 },
              { npmSpec: name, ...metadata },
            ),
            version,
            source: "external",
            kind: "channel",
          },
          tempDir(),
          true,
        );
        const entry = lookup("prerelease-demo", { catalogPaths: [file] });
        const spec = `${name}@${version}`;
        expect(entry).toMatchObject({
          meta: richMeta,
          install: { npmSpec: spec, ...metadata },
          installSource: {
            defaultChoice: "npm",
            npm: { spec, expectedIntegrity: metadata.expectedIntegrity },
            warnings: [],
          },
        });
      },
    );
    it("preserves ClawHub-only install metadata", () => {
      const spec = "clawhub:openclaw/clawhub-chat@2026.5.2";
      const install = { clawhubSpec: spec, defaultChoice: "clawhub", minHostVersion: ">=2026.5.1" };
      const file = catalogFile(catalogEntry("clawhub-chat", null, {}, install));
      expect(lookup("clawhub-chat", { catalogPaths: [file] })).toMatchObject({
        install,
        installSource: { defaultChoice: "clawhub", clawhub: { spec }, warnings: [] },
      });
    });
  });
}
export function describeChannelPluginCatalogPathResolutionContract() {
  it.each([
    ["external", "catalog.json"],
    ["default", "plugins/catalog.json"],
  ])("uses the provided env for %s catalog paths", (source, relativePath) => {
    const dir = tempDir();
    const targetDir = path.dirname(path.join(dir, relativePath));
    fs.mkdirSync(targetDir, { recursive: true });
    catalogFile(catalogEntry("env-demo", undefined, { order: 1000 }), targetDir);
    const env =
      source === "external"
        ? { OPENCLAW_PLUGIN_CATALOG_PATHS: "~/catalog.json", OPENCLAW_HOME: dir, HOME: dir }
        : { OPENCLAW_STATE_DIR: dir };
    expect(
      listRawChannelPluginCatalogEntries({ env: { ...process.env, ...env } }).map(
        (entry) => entry.id,
      ),
    ).toContain("env-demo");
  });
}
