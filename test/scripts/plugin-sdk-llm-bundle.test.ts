import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import { listDirectoryTreeStrictSync } from "../../src/infra/directory-walk.js";
import buildConfigs from "../../tsdown.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("plugin-sdk/llm bundle", () => {
  // Source runs resolve both import paths to one module; only the bundle can split the symbols.
  it("keeps provider option symbols owned by the external @openclaw/ai package", async () => {
    const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
    const selected = configs.find(
      (config) =>
        config.entry &&
        typeof config.entry === "object" &&
        !Array.isArray(config.entry) &&
        "plugin-sdk/llm" in config.entry,
    );
    if (!selected) {
      throw new Error("Missing unified runtime build config");
    }
    const root = fs.realpathSync(createTempDir("openclaw-plugin-sdk-llm-"));
    const { bundles } = await build({
      ...selected,
      config: false,
      entry: { "plugin-sdk/llm": "src/plugin-sdk/llm.ts" },
      outDir: root,
      dts: false,
      sourcemap: false,
      logLevel: "silent",
    });
    try {
      const code = listDirectoryTreeStrictSync(root)
        .filter((entry) => /\.[cm]?js$/u.test(entry.relativePath))
        .map((entry) => fs.readFileSync(path.join(root, entry.relativePath), "utf8"))
        .join("\n");
      expect(code).toContain("resolveProviderContext");
      expect(code).not.toMatch(
        /Symbol\(\s*["'`](providerContextHandoff|providerModelInput|providerDeferredToolNames|nativeHistoricalToolCall)/u,
      );
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });
});
