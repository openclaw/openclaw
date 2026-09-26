// Covers stale local bundled plugin install record detection.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import {
  listObsoleteSourceCheckoutPluginInstallRecords,
  listStaleLocalBundledPluginInstallRecords,
  pruneStaleLocalBundledPluginInstallRecords,
} from "./stale-local-bundled-plugin-install-records.js";

function bundledSource(pluginId: string, localPath: string): Map<string, BundledPluginSource> {
  return new Map([
    [
      pluginId,
      {
        pluginId,
        localPath,
        version: "2026.5.20",
      },
    ],
  ]);
}

describe("listStaleLocalBundledPluginInstallRecords", () => {
  it("lists path install records that point at stale compiled bundled output", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");
    const stalePath = path.join("/tmp/old-openclaw", "dist", "extensions", "discord");
    const records: Record<string, PluginInstallRecord> = {
      discord: {
        source: "path",
        installPath: stalePath,
        version: "2026.5.4-beta.3",
      },
      brave: {
        source: "npm",
        installPath: "/tmp/plugins/brave",
      },
    };

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: records,
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual([
      {
        pluginId: "discord",
        record: records.discord,
        recordPathField: "installPath",
        stalePath,
        bundledPath: currentPath,
      },
    ]);
  });

  it("does not list the current bundled path", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: currentPath,
            version: "2026.5.4-beta.3",
          },
        },
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual([]);
  });

  it("does not list compiled bundled paths without a stale version", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: path.join("/tmp/local-openclaw", "dist", "extensions", "discord"),
          },
          acpx: {
            source: "path",
            installPath: path.join("/tmp/local-openclaw", "dist", "extensions", "acpx"),
            version: "2026.5.20",
          },
        },
        bundled: new Map([
          ...bundledSource("discord", currentPath),
          ...bundledSource("acpx", path.join("/opt/openclaw", "dist", "extensions", "acpx")),
        ]),
      }),
    ).toStrictEqual([]);
  });

  it("does not list source checkout or arbitrary local plugin paths", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");

    expect(
      listStaleLocalBundledPluginInstallRecords({
        installRecords: {
          discord: {
            source: "path",
            installPath: path.join("/tmp/openclaw", "extensions", "discord"),
            version: "2026.5.4-beta.3",
          },
          acpx: {
            source: "path",
            installPath: path.join("/tmp/custom-plugins", "acpx"),
            version: "2026.5.4-beta.3",
          },
        },
        bundled: new Map([
          ...bundledSource("discord", currentPath),
          ...bundledSource("acpx", path.join("/opt/openclaw", "dist", "extensions", "acpx")),
        ]),
      }),
    ).toStrictEqual([]);
  });
});

describe("listObsoleteSourceCheckoutPluginInstallRecords", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function makeCheckout(options: { git: boolean }): string {
    const checkout = tempDirs.make("openclaw-checkout-");
    fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "openclaw" }));
    fs.writeFileSync(path.join(checkout, "pnpm-workspace.yaml"), "packages: []\n");
    fs.mkdirSync(path.join(checkout, "src"));
    fs.mkdirSync(path.join(checkout, "extensions"));
    if (options.git) {
      fs.mkdirSync(path.join(checkout, ".git"));
    }
    return checkout;
  }

  function pathRecord(pluginDir: string): PluginInstallRecord {
    return {
      source: "path",
      sourcePath: pluginDir,
      installPath: pluginDir,
      spec: "@openclaw/discord@2026.9.2",
      version: "2026.9.2",
    };
  }

  it("lists only in-place checkout copies of official plugins the core does not bundle", () => {
    const checkout = makeCheckout({ git: true });
    const unversionedCheckout = makeCheckout({ git: false });
    const discordDir = path.join(checkout, "extensions", "discord");
    const records: Record<string, PluginInstallRecord> = {
      discord: pathRecord(discordDir),
      slack: pathRecord(path.join(unversionedCheckout, "extensions", "slack")),
      matrix: pathRecord(path.join(checkout, "extensions", "matrix-fork")),
      signal: { source: "npm", installPath: path.join(checkout, "extensions", "signal") },
      "my-local": pathRecord(path.join(checkout, "extensions", "my-local")),
    };

    expect(
      listObsoleteSourceCheckoutPluginInstallRecords({
        installRecords: records,
        currentBundledPluginIds: new Set(),
        env: {},
      }),
    ).toEqual([
      {
        pluginId: "discord",
        record: records.discord,
        checkoutPluginDir: discordDir,
        official: {
          label: "Discord",
          npmSpec: "@openclaw/discord",
          clawhubSpec: "clawhub:@openclaw/discord",
        },
      },
    ]);
  });

  it("leaves checkout copies owned by the running core or the dev source root", () => {
    const checkout = makeCheckout({ git: true });
    const discordDir = path.join(checkout, "extensions", "discord");
    fs.mkdirSync(discordDir);
    const installRecords = { discord: pathRecord(discordDir) };
    const listIds = (params: { bundled?: string[]; env?: NodeJS.ProcessEnv }) =>
      listObsoleteSourceCheckoutPluginInstallRecords({
        installRecords,
        currentBundledPluginIds: new Set(params.bundled),
        env: params.env ?? {},
      }).map(({ pluginId }) => pluginId);

    expect(listIds({})).toEqual(["discord"]);
    expect(listIds({ bundled: ["discord"] })).toEqual([]);
    expect(listIds({ env: { OPENCLAW_DEV_SOURCE_ROOT: checkout } })).toEqual([]);
  });
});

describe("pruneStaleLocalBundledPluginInstallRecords", () => {
  it("removes only stale local bundled plugin install records", () => {
    const currentPath = path.join("/opt/openclaw", "dist", "extensions", "discord");
    const stalePath = path.join("/tmp/old-openclaw", "dist", "extensions", "discord");
    const records: Record<string, PluginInstallRecord> = {
      discord: {
        source: "path",
        installPath: stalePath,
        version: "2026.5.4-beta.3",
      },
      brave: {
        source: "npm",
        installPath: "/tmp/plugins/brave",
      },
    };

    expect(
      pruneStaleLocalBundledPluginInstallRecords({
        installRecords: records,
        bundled: bundledSource("discord", currentPath),
      }),
    ).toStrictEqual({
      records: {
        brave: records.brave,
      },
      stale: [
        {
          pluginId: "discord",
          record: records.discord,
          recordPathField: "installPath",
          stalePath,
          bundledPath: currentPath,
        },
      ],
    });
  });
});
