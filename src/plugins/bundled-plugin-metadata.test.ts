import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectBundledPluginMetadata,
  writeBundledPluginMetadataModule,
} from "../../scripts/generate-bundled-plugin-metadata.mjs";
import {
  BUNDLED_PLUGIN_METADATA,
  resolveBundledPluginGeneratedPath,
} from "./bundled-plugin-metadata.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tempDirs: string[] = [];

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bundled plugin metadata", () => {
  it("matches the generated metadata snapshot", () => {
    expect(BUNDLED_PLUGIN_METADATA).toEqual(collectBundledPluginMetadata({ repoRoot }));
  });

  it("captures setup-entry metadata for bundled channel plugins", () => {
    const discord = BUNDLED_PLUGIN_METADATA.find((entry) => entry.dirName === "discord");
    expect(discord?.source).toEqual({ source: "./index.ts", built: "index.js" });
    expect(discord?.setupSource).toEqual({ source: "./setup-entry.ts", built: "setup-entry.js" });
    expect(discord?.manifest.id).toBe("discord");
  });

  it("prefers built generated paths when present and falls back to source paths", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-plugin-metadata-"));
    tempDirs.push(tempRoot);

    fs.mkdirSync(path.join(tempRoot, "plugin"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "plugin", "index.ts"), "export {};\n", "utf8");
    expect(
      resolveBundledPluginGeneratedPath(tempRoot, {
        source: "plugin/index.ts",
        built: "plugin/index.js",
      }),
    ).toBe(path.join(tempRoot, "plugin", "index.ts"));

    fs.writeFileSync(path.join(tempRoot, "plugin", "index.js"), "export {};\n", "utf8");
    expect(
      resolveBundledPluginGeneratedPath(tempRoot, {
        source: "plugin/index.ts",
        built: "plugin/index.js",
      }),
    ).toBe(path.join(tempRoot, "plugin", "index.js"));
  });

  it("supports check mode for stale generated artifacts", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-plugin-generated-"));
    tempDirs.push(tempRoot);

    writeJson(path.join(tempRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    writeJson(path.join(tempRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: { type: "object" },
    });

    const initial = writeBundledPluginMetadataModule({
      repoRoot: tempRoot,
      outputPath: "src/plugins/bundled-plugin-metadata.generated.ts",
    });
    expect(initial.wrote).toBe(true);

    const current = writeBundledPluginMetadataModule({
      repoRoot: tempRoot,
      outputPath: "src/plugins/bundled-plugin-metadata.generated.ts",
      check: true,
    });
    expect(current.changed).toBe(false);
    expect(current.wrote).toBe(false);

    fs.writeFileSync(
      path.join(tempRoot, "src/plugins/bundled-plugin-metadata.generated.ts"),
      "// stale\n",
      "utf8",
    );

    const stale = writeBundledPluginMetadataModule({
      repoRoot: tempRoot,
      outputPath: "src/plugins/bundled-plugin-metadata.generated.ts",
      check: true,
    });
    expect(stale.changed).toBe(true);
    expect(stale.wrote).toBe(false);
  });
});
