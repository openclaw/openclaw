import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import { getChannelPluginCatalogEntry, listRawChannelPluginCatalogEntries } from "../../catalog.js";

type CatalogEntryMeta = {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  detailLabel?: string;
  aliases?: string[];
};

function createCatalogDir(prefix: string) {
  return fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), prefix));
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function writeCatalog(dir: string, name: string, channel: CatalogEntryMeta, install: object) {
  const file = path.join(dir, "catalog.json");
  writeJson(file, { entries: [{ name, openclaw: { channel, install } }] });
  return file;
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
  meta: CatalogEntryMeta;
  defaultChoice?: string;
}) {
  it(`${params.pluginId} bundled metadata-only channel catalog contract includes the bundled metadata-only channel entry when the runtime entrypoint is omitted`, () => {
    const workspaceDir = createCatalogDir("openclaw-bundled-catalog-");
    const bundledDir = path.join(workspaceDir, ".openclaw", "extensions", params.pluginId);
    fs.mkdirSync(bundledDir, { recursive: true });
    writeJson(path.join(workspaceDir, "package.json"), { name: "openclaw" });
    writeJson(path.join(bundledDir, "package.json"), {
      name: params.packageName,
      openclaw: {
        extensions: ["./index.js"],
        channel: params.meta,
        install: {
          npmSpec: params.npmSpec,
          defaultChoice: params.defaultChoice,
        },
      },
    });
    fs.writeFileSync(path.join(bundledDir, "index.js"), "export default {};\n", "utf8");
    writeJson(path.join(bundledDir, "openclaw.plugin.json"), {
      id: params.pluginId,
      channels: [params.meta.id],
      configSchema: {},
    });

    const entry = listRawChannelPluginCatalogEntries({
      workspaceDir,
      env: { ...process.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    }).find((item) => item.id === params.meta.id);

    expect(entry).toMatchObject({
      install: { npmSpec: params.npmSpec },
      pluginId: params.pluginId,
    });
  });
}

export function describeOfficialFallbackChannelCatalogContract(params: {
  channelId: string;
  npmSpec: string;
  meta: CatalogEntryMeta;
  packageName: string;
  externalNpmSpec: string;
  externalLabel: string;
}) {
  describe(`${params.channelId} official fallback channel catalog contract`, () => {
    const lookup = (options: Parameters<typeof listRawChannelPluginCatalogEntries>[0]) =>
      listRawChannelPluginCatalogEntries({
        env: {
          ...process.env,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
        },
        ...options,
      }).find((item) => item.id === params.channelId);
    it.each([
      ["includes shipped official channel catalog entries when bundled metadata is omitted", false],
      ["lets external catalogs override shipped fallback channel metadata", true],
    ] as const)("%s", (_name, external) => {
      const dir = createCatalogDir("openclaw-fallback-catalog-");
      let catalogPaths: string[] | undefined;
      if (external) {
        catalogPaths = [
          writeCatalog(
            dir,
            params.externalNpmSpec,
            {
              ...params.meta,
              label: params.externalLabel,
              selectionLabel: params.externalLabel,
              blurb: "external override",
            },
            { npmSpec: params.externalNpmSpec },
          ),
        ];
      }
      const entry = lookup({
        catalogPaths,
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
      const catalogPath = writeCatalog(
        createCatalogDir("openclaw-drifted-catalog-"),
        params.packageName,
        params.meta,
        { npmSpec: `${params.packageName}-fork@1.2.3`, expectedIntegrity: "sha512-drifted" },
      );

      const entry = lookup({ catalogPaths: [catalogPath], officialCatalogPaths: [] });

      expect(entry?.installSource?.npm).toMatchObject({
        packageName: `${params.packageName}-fork`,
        expectedPackageName: params.packageName,
      });
      expect(entry?.installSource?.warnings).toEqual(["npm-spec-package-name-mismatch"]);
    });
  });
}
