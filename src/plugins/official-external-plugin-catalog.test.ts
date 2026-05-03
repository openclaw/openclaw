import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getOfficialExternalPluginCatalogEntry,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";

describe("official external plugin catalog", () => {
  it("resolves third-party channel lookup aliases to published plugin ids", () => {
    const wecomByChannel = getOfficialExternalPluginCatalogEntry("wecom");
    const wecomByPlugin = getOfficialExternalPluginCatalogEntry("wecom-openclaw-plugin");
    const yuanbaoByChannel = getOfficialExternalPluginCatalogEntry("yuanbao");

    expect(resolveOfficialExternalPluginId(wecomByChannel!)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginId(wecomByPlugin!)).toBe("wecom-openclaw-plugin");
    expect(resolveOfficialExternalPluginInstall(wecomByChannel!)?.npmSpec).toBe(
      "@wecom/wecom-openclaw-plugin@2026.4.23",
    );
    expect(resolveOfficialExternalPluginId(yuanbaoByChannel!)).toBe("openclaw-plugin-yuanbao");
    expect(resolveOfficialExternalPluginInstall(yuanbaoByChannel!)?.npmSpec).toBe(
      "openclaw-plugin-yuanbao@2.11.0",
    );
  });

  it("opts current beta-only official launch packages into prerelease npm tags", () => {
    expect(
      resolveOfficialExternalPluginInstall(getOfficialExternalPluginCatalogEntry("acpx")!)?.npmSpec,
    ).toBe("@openclaw/acpx@beta");
    expect(
      resolveOfficialExternalPluginInstall(getOfficialExternalPluginCatalogEntry("googlechat")!)
        ?.npmSpec,
    ).toBe("@openclaw/googlechat@beta");
    expect(
      resolveOfficialExternalPluginInstall(getOfficialExternalPluginCatalogEntry("line")!)?.npmSpec,
    ).toBe("@openclaw/line@beta");
  });

  it("keeps Matrix and Mattermost out of the external catalog until cutover", () => {
    const ids = new Set(
      listOfficialExternalPluginCatalogEntries()
        .map((entry) => resolveOfficialExternalPluginId(entry))
        .filter(Boolean),
    );

    expect(ids.has("matrix")).toBe(false);
    expect(ids.has("mattermost")).toBe(false);
  });

  it("keeps local package install metadata aligned with external catalog specs", () => {
    const mismatches: string[] = [];

    for (const entry of listOfficialExternalPluginCatalogEntries()) {
      const pluginId = resolveOfficialExternalPluginId(entry);
      const catalogInstall = resolveOfficialExternalPluginInstall(entry);
      if (!pluginId || !catalogInstall) {
        continue;
      }
      const packagePath = path.join("extensions", pluginId, "package.json");
      if (!fs.existsSync(packagePath)) {
        continue;
      }
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
        openclaw?: {
          install?: {
            clawhubSpec?: string;
            npmSpec?: string;
          };
        };
      };
      const packageInstall = packageJson.openclaw?.install ?? {};
      if (packageInstall.npmSpec && packageInstall.npmSpec !== catalogInstall.npmSpec) {
        mismatches.push(
          `${pluginId} npmSpec catalog=${catalogInstall.npmSpec ?? "<none>"} package=${packageInstall.npmSpec}`,
        );
      }
      if (packageInstall.clawhubSpec && packageInstall.clawhubSpec !== catalogInstall.clawhubSpec) {
        mismatches.push(
          `${pluginId} clawhubSpec catalog=${catalogInstall.clawhubSpec ?? "<none>"} package=${packageInstall.clawhubSpec}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });
});
