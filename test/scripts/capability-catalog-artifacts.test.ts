import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import { collectSourceCheckoutPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import {
  resolveAugmentedPluginNpmManifest,
  withAugmentedPluginNpmManifestForPackage,
} from "../../scripts/lib/plugin-npm-package-manifest.mts";
import { resolvePluginNpmRuntimeBuildPlan } from "../../scripts/lib/plugin-npm-runtime-build.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function catalogs(prefix: string, extension: string) {
  return {
    capabilityCatalogEntry: `${prefix}/catalog/voice${extension}`,
    providerCatalogEntry: `${prefix}/catalog/models${extension}`,
  };
}

describe("capability catalog artifact ownership", () => {
  it.each([
    { runtimeFormat: "esm", browser: false },
    { runtimeFormat: "cjs", browser: false },
    { runtimeFormat: "esm", browser: true },
  ] as const)(
    "carries declarations into $runtimeFormat artifacts (browser: $browser)",
    ({ runtimeFormat, browser }) => {
      const root = tempDirs.make("openclaw-catalog-artifacts-");
      const plugin = path.join(root, "extensions", "catalog-fixture");
      const write = (file: string, content: string) => {
        const target = path.join(plugin, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      };
      const readManifest = () => fs.readFileSync(path.join(plugin, "openclaw.plugin.json"), "utf8");
      const params = { repoRoot: root, packageDir: plugin };
      const manifest = {
        id: "catalog-fixture",
        configSchema: { type: "object" },
        ...(browser
          ? { controlUi: { entry: "dist/control-ui/authored/index.js" } }
          : catalogs(".", ".ts")),
      };
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      write(
        "package.json",
        JSON.stringify({
          name: "@openclaw/catalog-fixture",
          version: "2026.9.1",
          openclaw: {
            extensions: ["./index.ts"],
            ...(browser ? { controlUi: "./browser.ts" } : {}),
            release: { publishToNpm: true },
            build: { bundledDist: false, runtimeFormat },
          },
        }),
      );
      write("openclaw.plugin.json", JSON.stringify(manifest));
      for (const file of ["index.ts", "browser.ts", "catalog/voice.ts", "catalog/models.ts"]) {
        write(file, "export default {};\n");
      }

      const [entry] = collectSourceCheckoutPluginBuildEntries({ cwd: root, env: {} });
      const extension = runtimeFormat === "cjs" ? ".cjs" : ".js";
      const plan = resolvePluginNpmRuntimeBuildPlan(params)!;
      const expected = browser
        ? { controlUi: { entry: "dist/control-ui/fresh/index.js" } }
        : catalogs("./dist", extension);
      if (browser) {
        write("dist/openclaw.plugin.json", JSON.stringify(expected));
        for (const output of plan.runtimeBuildOutputs) {
          write(output, "export default {};\n");
        }
        const authoredBytes = readManifest();
        withAugmentedPluginNpmManifestForPackage(params, () => {
          expect(JSON.parse(readManifest())).toMatchObject(expected);
        });
        expect(readManifest()).toBe(authoredBytes);
      } else {
        expect(entry?.sourceEntries).toEqual(
          expect.arrayContaining(["./catalog/voice.ts", "./catalog/models.ts"]),
        );
        expect(plan.entry["catalog/voice"]).toBe(path.join(plugin, "catalog/voice.ts"));
        expect(plan.runtimeBuildOutputs).toContain(`./dist/catalog/voice${extension}`);
      }
      expect(resolveAugmentedPluginNpmManifest(params).manifest).toMatchObject(expected);

      copyBundledPluginMetadata({ cwd: root, env: {} });
      const emitted = JSON.parse(
        fs.readFileSync(
          path.join(root, "dist", "extensions", "catalog-fixture", "openclaw.plugin.json"),
          "utf8",
        ),
      );
      expect(emitted).toMatchObject(browser ? expected : catalogs(".", extension));
      expect(JSON.parse(readManifest())).toEqual(manifest);
    },
  );
});
