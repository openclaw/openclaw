import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { MAX_PLUGIN_ACTIVITY_TOOL_ICONS } from "./portable-icon-paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createIconFixture(bundle = false) {
  const rootDir = tempDirs.make("openclaw-plugin-theme-icons-");
  fs.mkdirSync(path.join(rootDir, "assets"));
  fs.writeFileSync(
    path.join(rootDir, bundle ? "plugin.json" : "openclaw.plugin.json"),
    JSON.stringify(
      bundle
        ? {
            $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            name: "Theme Icons",
          }
        : { id: "theme-icons", configSchema: { type: "object" } },
    ),
  );
  const load = () =>
    loadPluginManifestRegistryCore({
      candidates: [
        {
          idHint: "theme-icons",
          rootDir,
          source: path.join(rootDir, "index.ts"),
          origin: "global",
          ...(bundle ? ({ format: "bundle", bundleFormat: "agent" } as const) : {}),
        },
      ],
    }).plugins[0];
  return { rootDir, load };
}

describe("portable plugin theme artwork", () => {
  it.each([false, true])(
    "discovers optional variants from prepared plugin metadata (bundle=%s)",
    (bundle) => {
      const { rootDir, load } = createIconFixture(bundle);
      for (const file of ["icon.png", "icon-light.png", "icon-dark.png"]) {
        fs.writeFileSync(path.join(rootDir, "assets", file), "presentation artwork");
      }

      expect(load()).toMatchObject({
        iconPath: path.join(rootDir, "assets/icon.png"),
        themeIconPaths: {
          light: path.join(rootDir, "assets/icon-light.png"),
          dark: path.join(rootDir, "assets/icon-dark.png"),
        },
      });
    },
  );

  it.each([1, MAX_PLUGIN_ACTIVITY_TOOL_ICONS + 1])(
    "retains theme artwork alongside a directory of %i activity icons",
    (toolCount) => {
      const { rootDir, load } = createIconFixture();
      for (const file of ["icon.png", "icon-light.png", "icon-dark.png", "activity.svg"]) {
        fs.writeFileSync(path.join(rootDir, "assets", file), "presentation artwork");
      }
      const activityDir = path.join(rootDir, "assets/activity");
      fs.mkdirSync(activityDir);
      for (let index = 0; index < toolCount; index++) {
        fs.writeFileSync(path.join(activityDir, `tool_${index}.svg`), "tool activity");
      }

      const manifest = load();
      expect(manifest).toMatchObject({
        iconPath: path.join(rootDir, "assets/icon.png"),
        themeIconPaths: {
          light: path.join(rootDir, "assets/icon-light.png"),
          dark: path.join(rootDir, "assets/icon-dark.png"),
        },
        activityIconPath: path.join(rootDir, "assets/activity.svg"),
      });
      expect(manifest?.toolActivityIconPaths).toEqual(
        toolCount > MAX_PLUGIN_ACTIVITY_TOOL_ICONS
          ? undefined
          : { tool_0: path.join(activityDir, "tool_0.svg") },
      );
    },
  );

  it("ignores variants without the portable fallback", () => {
    const { rootDir, load } = createIconFixture();
    fs.writeFileSync(path.join(rootDir, "assets/icon-dark.png"), "dark artwork");

    const manifest = load();
    expect(manifest).toBeDefined();
    expect(manifest?.iconPath).toBeUndefined();
    expect(manifest?.themeIconPaths).toBeUndefined();
  });

  it("ignores non-file variants while retaining the portable fallback", () => {
    const { rootDir, load } = createIconFixture();
    fs.writeFileSync(path.join(rootDir, "assets/icon.png"), "fallback artwork");
    fs.mkdirSync(path.join(rootDir, "assets/icon-light.png"));

    const manifest = load();
    expect(manifest?.iconPath).toBe(path.join(rootDir, "assets/icon.png"));
    expect(manifest?.themeIconPaths).toBeUndefined();
  });

  it("does not discover a themed symlink outside the plugin", () => {
    const { rootDir, load } = createIconFixture();
    const outside = tempDirs.make("openclaw-plugin-external-icon-");
    fs.writeFileSync(path.join(rootDir, "assets/icon.png"), "fallback artwork");
    fs.writeFileSync(path.join(outside, "icon.png"), "external artwork");
    try {
      fs.symlinkSync(path.join(outside, "icon.png"), path.join(rootDir, "assets/icon-dark.png"));
    } catch (error) {
      if (
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        return;
      }
      throw error;
    }

    const manifest = load();
    expect(manifest?.iconPath).toBe(path.join(rootDir, "assets/icon.png"));
    expect(manifest?.themeIconPaths).toBeUndefined();
  });
});
