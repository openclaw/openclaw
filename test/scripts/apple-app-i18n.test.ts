import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkAppleAppI18n, compileMacosLocalizations } from "../../scripts/apple-app-i18n.ts";

describe("Apple app i18n catalogs", () => {
  it("keeps phased source coverage complete for every native locale", async () => {
    await expect(checkAppleAppI18n()).resolves.toBeUndefined();
  });

  it("does not mark English setup fallbacks as completed translations", async () => {
    const catalog = JSON.parse(
      await readFile("apps/ios/Resources/Localizable.xcstrings", "utf8"),
    ) as {
      strings: Record<
        string,
        { localizations?: Record<string, { stringUnit?: { state?: string; value?: string } }> }
      >;
    };

    expect(
      catalog.strings["Connect a nearby Gateway"]?.localizations?.de?.stringUnit,
    ).toMatchObject({
      state: "new",
      value: "Connect a nearby Gateway",
    });
  });

  it("compiles macOS catalogs into app-bundle localization directories", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-apple-i18n-"));
    try {
      await compileMacosLocalizations(outputDir);
      const swedish = await readFile(
        path.join(outputDir, "sv.lproj", "Localizable.strings"),
        "utf8",
      );
      expect(swedish).toContain('"Logout" = "Logga ut";');
      await expect(
        readFile(path.join(outputDir, "zh-Hans.lproj", "Localizable.strings"), "utf8"),
      ).resolves.toContain('"Save" = ');
      await expect(
        readFile(path.join(outputDir, "ja.lproj", "Localizable.strings"), "utf8"),
      ).resolves.toContain('"Run now" = ');
    } finally {
      await rm(outputDir, { force: true, recursive: true });
    }
  });
});
