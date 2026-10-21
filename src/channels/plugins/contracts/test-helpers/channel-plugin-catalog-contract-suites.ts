import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import { listRawChannelPluginCatalogEntries } from "../../catalog.js";

type ChannelCatalogContractCase = {
  name: string;
  setup: () => {
    catalogPaths?: string[];
    env?: NodeJS.ProcessEnv;
    channelId: string;
    expected: Record<string, unknown>;
  };
};

type RichExternalCatalogFixture = {
  name: string;
  prefix: string;
  channelId: string;
  packageName?: string;
  meta: Record<string, unknown>;
  aliases: string[];
  order: number;
  install: Record<string, unknown>;
  installSource?: Record<string, unknown>;
};

function createCatalogEntry(params: {
  packageName?: string;
  channelId: string;
  label?: string;
  blurb?: string;
  order?: number;
}) {
  const packageName = params.packageName ?? `@openclaw/${params.channelId}`;
  const label = params.label ?? params.channelId;
  return {
    name: packageName,
    openclaw: {
      channel: {
        id: params.channelId,
        label,
        selectionLabel: label,
        docsPath: `/channels/${params.channelId}`,
        blurb: params.blurb ?? "catalog fixture",
        ...(params.order === undefined ? {} : { order: params.order }),
      },
      install: { npmSpec: packageName },
    },
  };
}

function writeCatalog(catalogPath: string, entry: Record<string, unknown>, richManifest = false) {
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      ...(richManifest
        ? {
            $schema: "./manifest.schema.json",
            schemaVersion: 1,
            description:
              "Extension manifest. Declares plugin packages that OpenClaw can discover during onboarding and install on demand via `openclaw plugins install`.",
          }
        : {}),
      entries: [entry],
    }),
  );
}

function createTemporaryCatalogFile(
  prefix: string,
  entry: Record<string, unknown>,
  richManifest = false,
) {
  const directory = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), prefix));
  const catalogPath = path.join(directory, "catalog.json");
  writeCatalog(catalogPath, entry, richManifest);
  return catalogPath;
}

function writeDiscoveredChannelPlugin(stateDir: string) {
  const pluginDir = path.join(stateDir, "extensions", "demo-channel-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const entry = createCatalogEntry({
    packageName: "@vendor/demo-channel-plugin",
    channelId: "demo-channel",
    label: "Demo Channel Runtime",
  });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ ...entry, openclaw: { ...entry.openclaw, extensions: ["./index.js"] } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({ id: "@vendor/demo-channel-runtime", configSchema: {} }),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {}", "utf8");
}

function createRichExternalCatalogCase(
  fixture: RichExternalCatalogFixture,
): ChannelCatalogContractCase {
  const entry = {
    name: fixture.packageName,
    source: "external",
    kind: "channel",
    openclaw: {
      channel: {
        id: fixture.channelId,
        ...fixture.meta,
        aliases: fixture.aliases,
        order: fixture.order,
      },
      install: fixture.install,
    },
  };
  return {
    name: fixture.name,
    setup: () => ({
      channelId: fixture.channelId,
      catalogPaths: [createTemporaryCatalogFile(fixture.prefix, entry, true)],
      expected: {
        id: fixture.channelId,
        meta: fixture.meta,
        install: fixture.install,
        ...(fixture.installSource ? { installSource: fixture.installSource } : {}),
      },
    }),
  };
}

const [richNpmCatalogFixture, clawhubCatalogFixture, yuanbaoCatalogFixture] = [
  {
    name: "accepts rich external manifest entries with pinned npm metadata",
    prefix: "openclaw-catalog-rich-",
    channelId: "wecom",
    packageName: "@wecom/wecom-openclaw-plugin",
    aliases: ["qywx", "wework"],
    order: 45,
    meta: {
      label: "WeCom",
      selectionLabel: "WeCom (企业微信)",
      detailLabel: "WeCom",
      docsPath: "/channels/wecom",
      docsLabel: "wecom",
      blurb: "企业微信 (WeCom) bot & conversation channel.",
    },
    install: {
      npmSpec: "@wecom/wecom-openclaw-plugin@1.2.3",
      defaultChoice: "npm",
      minHostVersion: ">=2026.4.10",
      expectedIntegrity: "sha512-wecom",
    },
    installSource: {
      defaultChoice: "npm",
      npm: {
        spec: "@wecom/wecom-openclaw-plugin@1.2.3",
        packageName: "@wecom/wecom-openclaw-plugin",
        selector: "1.2.3",
        selectorKind: "exact-version",
        exactVersion: true,
        expectedIntegrity: "sha512-wecom",
        pinState: "exact-with-integrity",
      },
      warnings: [],
    },
  },
  {
    name: "accepts external manifest entries with ClawHub-only install metadata",
    prefix: "openclaw-catalog-clawhub-",
    channelId: "clawhub-chat",
    aliases: ["chchat"],
    order: 47,
    meta: {
      label: "ClawHub Chat",
      selectionLabel: "ClawHub Chat",
      detailLabel: "ClawHub",
      docsPath: "/channels/clawhub-chat",
      docsLabel: "clawhub chat",
      blurb: "ClawHub-backed chat channel.",
    },
    install: {
      clawhubSpec: "clawhub:openclaw/clawhub-chat@2026.5.2",
      defaultChoice: "clawhub",
      minHostVersion: ">=2026.5.1",
    },
    installSource: {
      defaultChoice: "clawhub",
      clawhub: {
        spec: "clawhub:openclaw/clawhub-chat@2026.5.2",
        packageName: "openclaw/clawhub-chat",
        version: "2026.5.2",
        exactVersion: true,
      },
      warnings: [],
    },
  },
  {
    name: "accepts rich external manifest entries for yuanbao with pinned npm metadata",
    prefix: "openclaw-catalog-yuanbao-",
    channelId: "openclaw-plugin-yuanbao",
    packageName: "openclaw-plugin-yuanbao",
    aliases: ["yb", "tencent-yuanbao"],
    order: 78,
    meta: {
      label: "Yuanbao",
      selectionLabel: "Yuanbao (Tencent Yuanbao)",
      detailLabel: "Yuanbao",
      docsPath: "/channels/yuanbao",
      docsLabel: "yuanbao",
      blurb: "Tencent Yuanbao AI assistant conversation channel.",
    },
    install: {
      npmSpec: "openclaw-plugin-yuanbao@1.0.0",
      defaultChoice: "npm",
      minHostVersion: ">=2026.4.10",
      expectedIntegrity: "sha512-yuanbao",
    },
  },
] satisfies [RichExternalCatalogFixture, RichExternalCatalogFixture, RichExternalCatalogFixture];

export function describeChannelPluginCatalogEntriesContract() {
  const cases: ChannelCatalogContractCase[] = [
    {
      name: "keeps discovered plugins ahead of external catalog overrides",
      setup: () => {
        const stateDir = fs.mkdtempSync(
          path.join(resolvePreferredOpenClawTmpDir(), "openclaw-catalog-state-"),
        );
        const catalogPath = path.join(stateDir, "catalog.json");
        writeDiscoveredChannelPlugin(stateDir);
        writeCatalog(
          catalogPath,
          createCatalogEntry({
            packageName: "@vendor/demo-channel-catalog",
            channelId: "demo-channel",
            label: "Demo Channel Catalog",
          }),
        );
        return {
          channelId: "demo-channel",
          catalogPaths: [catalogPath],
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            CLAWDBOT_STATE_DIR: undefined,
            OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
          },
          expected: {
            install: { npmSpec: "@vendor/demo-channel-plugin" },
            meta: { label: "Demo Channel Runtime" },
            pluginId: "@vendor/demo-channel-runtime",
          },
        };
      },
    },
    createRichExternalCatalogCase(richNpmCatalogFixture),
    {
      name: "pins bare external prerelease package specs to the entry version",
      setup: () => ({
        channelId: "prerelease-demo",
        catalogPaths: [
          createTemporaryCatalogFile("openclaw-catalog-prerelease-", {
            ...createCatalogEntry({
              packageName: "@openclaw/prerelease-demo-channel",
              channelId: "prerelease-demo",
              label: "Prerelease Demo",
            }),
            version: "2026.5.3-beta.1",
          }),
        ],
        expected: {
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
        },
      }),
    },
    createRichExternalCatalogCase(clawhubCatalogFixture),
    createRichExternalCatalogCase(yuanbaoCatalogFixture),
  ];

  describe("channel plugin catalog entries contract", () => {
    it.each(cases)("$name", ({ setup }) => {
      const { channelId, expected, ...options } = setup();
      expect(
        listRawChannelPluginCatalogEntries(options).find((entry) => entry.id === channelId),
      ).toMatchObject(expected);
    });
  });
}

export function describeChannelPluginCatalogPathResolutionContract() {
  describe("channel plugin catalog path resolution contract", () => {
    it.each([
      {
        name: "uses the provided env for external catalog path resolution",
        relativePath: "catalog.json",
        entry: { channelId: "env-demo-channel", order: 1000 },
        env: (dir: string) => ({
          OPENCLAW_PLUGIN_CATALOG_PATHS: "~/catalog.json",
          OPENCLAW_HOME: dir,
          HOME: dir,
        }),
      },
      {
        name: "uses the provided env for default catalog paths",
        relativePath: "plugins/catalog.json",
        entry: { channelId: "default-env-demo" },
        env: (dir: string) => ({ OPENCLAW_STATE_DIR: dir }),
      },
    ])("$name", ({ relativePath, entry, env }) => {
      const dir = fs.mkdtempSync(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-catalog-path-"),
      );
      const catalogPath = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
      writeCatalog(catalogPath, createCatalogEntry(entry));
      expect(
        listRawChannelPluginCatalogEntries({ env: { ...process.env, ...env(dir) } }).map(
          (item) => item.id,
        ),
      ).toContain(entry.channelId);
    });
  });
}
