import { describe, expect, it } from "vitest";
import {
  collectAppcastSparkleVersionErrors,
  collectMissingControlUiLocaleChunkErrors,
} from "../scripts/release-check.ts";

function makeItem(shortVersion: string, sparkleVersion: string): string {
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version></item>`;
}

describe("collectAppcastSparkleVersionErrors", () => {
  it("accepts legacy 9-digit calver builds before lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.2.26", "202602260")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });

  it("requires lane-floor builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "202603010")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
    ]);
  });

  it("accepts canonical stable lane builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "2026030190")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });
});

describe("collectMissingControlUiLocaleChunkErrors", () => {
  it("accepts one lazy chunk per supported non-default locale", () => {
    const paths = [
      "dist/control-ui/index.html",
      "dist/control-ui/assets/de-Bm0iuKxz.js",
      "dist/control-ui/assets/es-ABCD1234.js",
      "dist/control-ui/assets/pt-BR-C2uaHesk.js",
      "dist/control-ui/assets/zh-CN-CqPGpAps.js",
      "dist/control-ui/assets/zh-TW-Cyl5GDQh.js",
    ];

    expect(
      collectMissingControlUiLocaleChunkErrors(paths, [
        "en",
        "de",
        "es",
        "pt-BR",
        "zh-CN",
        "zh-TW",
      ]),
    ).toEqual([]);
  });

  it("reports every lazy locale chunk missing from the npm pack", () => {
    const paths = [
      "dist/control-ui/index.html",
      "dist/control-ui/assets/de-Bm0iuKxz.js",
      "dist/control-ui/assets/es-ABCD1234.css",
    ];

    expect(
      collectMissingControlUiLocaleChunkErrors(paths, ["en", "de", "es", "pt-BR", "zh-CN"]),
    ).toEqual([
      "control-ui locale 'es' is missing its lazy chunk in npm pack.",
      "control-ui locale 'pt-BR' is missing its lazy chunk in npm pack.",
      "control-ui locale 'zh-CN' is missing its lazy chunk in npm pack.",
    ]);
  });
});
