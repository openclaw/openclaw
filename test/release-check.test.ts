import { describe, expect, it } from "vitest";
import {
  collectAppcastSparkleVersionErrors,
  collectBundledPluginPackDependencyErrors,
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

describe("collectBundledPluginPackDependencyErrors", () => {
  const feishuCheck = [
    {
      pluginId: "feishu",
      packageDir: "feishu",
      dependencies: ["@larksuiteoapi/node-sdk"],
    },
  ] as const;

  it("accepts bundled Feishu deps when the root package installs them", () => {
    expect(
      collectBundledPluginPackDependencyErrors({
        rootPackage: {
          dependencies: {
            "@larksuiteoapi/node-sdk": "^1.59.0",
          },
        },
        packPaths: [],
        checks: [...feishuCheck],
      }),
    ).toEqual([]);
  });

  it("accepts bundled Feishu deps when npm pack includes a plugin-local copy", () => {
    expect(
      collectBundledPluginPackDependencyErrors({
        rootPackage: {},
        packPaths: ["extensions/feishu/node_modules/@larksuiteoapi/node-sdk/package.json"],
        checks: [...feishuCheck],
      }),
    ).toEqual([]);
  });

  it("reports missing bundled Feishu deps when neither root nor pack carries them", () => {
    expect(
      collectBundledPluginPackDependencyErrors({
        rootPackage: {},
        packPaths: [],
        checks: [...feishuCheck],
      }),
    ).toEqual([
      'bundled plugin "feishu" depends on "@larksuiteoapi/node-sdk" but npm pack includes neither a root install dependency nor extensions/feishu/node_modules/@larksuiteoapi/node-sdk.',
    ]);
  });
});
