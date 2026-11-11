import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadControlUiSourceCatalog } from "../../../../scripts/lib/control-ui-i18n-catalog.ts";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import {
  channelDetailPresentations,
  type ChannelDetailPresentation,
} from "./detail-presentation.ts";

const declarations = import.meta.glob<ChannelDetailPresentation>(
  "../../../../extensions/*/control-ui.channel-detail.json",
  { eager: true, import: "default" },
);

describe("bundled channel detail presentation", () => {
  it("binds valid display facts and English keys to each owning plugin", () => {
    const english = flattenTranslations(loadControlUiSourceCatalog());
    const ids = new Set<string>();
    for (const [path, declaration] of Object.entries(declarations)) {
      const manifest = JSON.parse(
        readFileSync(
          new URL(
            path.replace("control-ui.channel-detail.json", "openclaw.plugin.json"),
            import.meta.url,
          ),
          "utf8",
        ),
      );
      expect(declaration.pluginId).toBe(manifest.id);
      expect(ids.has(declaration.pluginId)).toBe(false);
      ids.add(declaration.pluginId);
      expect(channelDetailPresentations.get(declaration.pluginId)).toEqual(declaration);
      expect(
        Object.keys(declaration).every((key) =>
          [
            "pluginId",
            "titleKey",
            "subtitleKey",
            "extraFacts",
            "runningWhenStatusMissing",
            "accounts",
          ].includes(key),
        ),
      ).toBe(true);
      for (const key of [declaration.titleKey, declaration.subtitleKey]) {
        const value = english.get(key);
        expect(typeof value).toBe("string");
        expect(value).not.toBe("");
      }
      for (const fact of declaration.extraFacts ?? []) {
        expect(["credential", "audience", "baseUrl", "mode"]).toContain(fact);
      }
      if (declaration.runningWhenStatusMissing !== undefined) {
        expect(declaration.runningWhenStatusMissing).toBe("unknown");
      }
      if (declaration.accounts) {
        expect(Object.keys(declaration.accounts).toSorted()).toEqual([
          "minimumCount",
          "showConfigured",
          "status",
          "titleSource",
        ]);
        expect(Number.isInteger(declaration.accounts.minimumCount)).toBe(true);
        expect(declaration.accounts.minimumCount).toBeGreaterThan(0);
        expect(["botUsername", "name"]).toContain(declaration.accounts.titleSource);
        expect(typeof declaration.accounts.showConfigured).toBe("boolean");
        expect(["running", "runningOrConfigured"]).toContain(declaration.accounts.status);
      }
    }
    expect([...ids].toSorted()).toEqual([
      "discord",
      "googlechat",
      "imessage",
      "signal",
      "slack",
      "telegram",
    ]);
    expect(channelDetailPresentations.has("__proto__")).toBe(false);
  });
});
