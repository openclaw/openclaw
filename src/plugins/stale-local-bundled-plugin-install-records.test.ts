import path from "node:path";
import { expect, it } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import {
  listStaleLocalBundledPluginInstallRecords,
  pruneStaleLocalBundledPluginInstallRecords,
} from "./stale-local-bundled-plugin-install-records.js";

const currentPath = (id: string) => path.join("/opt/openclaw", "dist", "extensions", id);
function bundledSources(...ids: string[]): Map<string, BundledPluginSource> {
  return new Map(
    ids.map((pluginId) => [
      pluginId,
      {
        pluginId,
        localPath: currentPath(pluginId),
        version: "2026.5.20",
      },
    ]),
  );
}
const localRecord = (installPath: string, version = "2026.5.4-beta.3"): PluginInstallRecord => ({
  source: "path",
  installPath,
  version,
});

const retainedRecords: Array<{ name: string; records: Record<string, PluginInstallRecord> }> = [
  { name: "the current bundled path", records: { discord: localRecord(currentPath("discord")) } },
  {
    name: "compiled bundled paths without a stale version",
    records: {
      discord: {
        source: "path",
        installPath: path.join("/tmp/local-openclaw", "dist", "extensions", "discord"),
      },
      acpx: localRecord(
        path.join("/tmp/local-openclaw", "dist", "extensions", "acpx"),
        "2026.5.20",
      ),
    },
  },
  {
    name: "source checkout or arbitrary local plugin paths",
    records: {
      discord: localRecord(path.join("/tmp/openclaw", "extensions", "discord")),
      acpx: localRecord(path.join("/tmp/custom-plugins", "acpx")),
    },
  },
];

it.each(retainedRecords)("does not list $name", ({ records }) => {
  expect(
    listStaleLocalBundledPluginInstallRecords({
      installRecords: records,
      bundled: bundledSources(...Object.keys(records)),
    }),
  ).toStrictEqual([]);
});

it("removes only stale local bundled plugin install records", () => {
  const stalePath = path.join("/tmp/old-openclaw", "dist", "extensions", "discord");
  const records: Record<string, PluginInstallRecord> = {
    discord: localRecord(stalePath),
    brave: {
      source: "npm",
      installPath: "/tmp/plugins/brave",
    },
  };

  expect(
    pruneStaleLocalBundledPluginInstallRecords({
      installRecords: records,
      bundled: bundledSources("discord"),
    }),
  ).toStrictEqual({
    records: { brave: records.brave },
    stale: [
      {
        pluginId: "discord",
        record: records.discord,
        stalePath,
        bundledPath: currentPath("discord"),
      },
    ],
  });
});
