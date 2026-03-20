import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildPluginSdkPackageExports, buildPluginSdkSpecifiers } from "./entrypoints.js";

const pluginSdkSpecifiers = buildPluginSdkSpecifiers();
const execFileAsync = promisify(execFile);

describe("plugin-sdk bundled exports", () => {
  it("emits importable bundled subpath entries", { timeout: 240_000 }, async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-build-"));
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-consumer-"));

    try {
      // Reuse the repo's tsdown config so plugin-sdk bundle checks stay aligned
      // with the production build graph and singleton boundaries.
      await execFileAsync(process.execPath, ["scripts/tsdown-build.mjs", "--outDir", outDir], {
        cwd: process.cwd(),
      });
      await fs.symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(outDir, "node_modules"),
        "dir",
      );

      const packageDir = path.join(fixtureDir, "openclaw");
      const consumerDir = path.join(fixtureDir, "consumer");
      const consumerEntry = path.join(consumerDir, "import-plugin-sdk.mjs");

      await fs.mkdir(packageDir, { recursive: true });
      await fs.symlink(outDir, path.join(packageDir, "dist"), "dir");
      // Mirror the installed package layout so subpaths can resolve root deps.
      await fs.symlink(
        path.join(process.cwd(), "node_modules"),
        path.join(packageDir, "node_modules"),
        "dir",
      );
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify(
          {
            exports: buildPluginSdkPackageExports(),
            name: "openclaw",
            type: "module",
          },
          null,
          2,
        ),
      );

      await fs.mkdir(path.join(consumerDir, "node_modules"), { recursive: true });
      await fs.symlink(packageDir, path.join(consumerDir, "node_modules", "openclaw"), "dir");
      await fs.writeFile(
        consumerEntry,
        [
          `const specifiers = ${JSON.stringify(pluginSdkSpecifiers)};`,
          "const results = {};",
          "for (const specifier of specifiers) {",
          "  results[specifier] = typeof (await import(specifier));",
          "}",
          "export default results;",
        ].join("\n"),
      );

      const { default: importResults } = await import(pathToFileURL(consumerEntry).href);
      expect(importResults).toEqual(
        Object.fromEntries(pluginSdkSpecifiers.map((specifier: string) => [specifier, "object"])),
      );
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
