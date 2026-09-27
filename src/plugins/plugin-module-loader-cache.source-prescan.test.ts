import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import * as sourceReferences from "./plugin-source-references.js";

it.each(["prepared", "explicit"] as const)(
  "loads a compiled SDK module without source-transform parsing (%s aliases)",
  async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-prescan-"));
    const owner = createPluginCache();
    const visit = vi.spyOn(sourceReferences, "visitPluginSourceReferences");
    try {
      fs.mkdirSync(path.join(root, "dist", "plugin-sdk"), { recursive: true });
      fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n");
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "openclaw",
          type: "module",
          bin: { openclaw: "openclaw.mjs" },
          exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" },
        }),
      );
      const sdk = path.join(root, "dist", "plugin-sdk", "core.js");
      fs.writeFileSync(sdk, "export const answer = 42;\n");
      const entry = path.join(root, "entry.mjs");
      fs.writeFileSync(entry, 'export { answer } from "openclaw/plugin-sdk/core";\n');
      const loaded = withPluginCache(owner, () =>
        getCachedPluginModuleLoader({
          modulePath: entry,
          importerUrl: pathToFileURL(entry).href,
          devSourceRoot: root,
          tryNative: true,
          ...(mode === "explicit" ? { aliasMap: { "openclaw/plugin-sdk/core": sdk } } : {}),
        })(entry),
      );
      expect(loaded).toMatchObject({ answer: 42 });
      expect(visit).not.toHaveBeenCalled();
    } finally {
      visit.mockRestore();
      await owner[Symbol.asyncDispose]();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
