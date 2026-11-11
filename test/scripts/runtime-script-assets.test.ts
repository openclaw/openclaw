import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { writeRuntimeScriptAssets } from "../../scripts/generate-runtime-script-assets.mjs";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.js";
import { runtimeProcessScriptEntrypoints } from "../../src/infra/runtime-process-manifest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps executable script assets current with their typed source", async () => {
  await expect(writeRuntimeScriptAssets({ check: true })).resolves.toEqual([]);
});

it("generates identical executable assets across dependency store locations", async () => {
  const root = tempDirs.make("runtime-script-assets-");
  const checkout = path.join(root, "checkout");
  fs.mkdirSync(path.join(checkout, "src/node-host"), { recursive: true });
  const put = (file: string, contents: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const source = 'import { value } from "fixture-dependency"; console.log(value);';
  for (const [entry, exportName] of [
    ["src/shared/keyboard-shortcuts.ts", "createKeyboardShortcutMatcher"],
    ["src/gateway/mcp-app-standalone-host.ts", "runStandaloneMcpAppHost"],
    [
      "src/gateway/worker-environments/repository-node-requirement.ts",
      "resolveRepositoryNodeRequirement",
    ],
  ] as const) {
    put(path.join(checkout, entry), `${source} export function ${exportName}() { return value; }`);
  }
  put(path.join(checkout, "src/cli/update-cli/update-command-native-gate.worker.ts"), source);
  for (const entry of Object.values(runtimeProcessScriptEntrypoints)) {
    if (("materialize" in entry && entry.materialize) || entry.kind === "data-url") {
      put(
        path.join(
          checkout,
          "runtimeEntrypoint" in entry
            ? runtimeProcessEntrypoints[entry.runtimeEntrypoint].sourceModulePath
            : entry.buildSource,
        ),
        source,
      );
    }
  }
  put(
    path.join(checkout, "src/infra/runtime-process-script-file.ts"),
    `${source} export function materializeRuntimeProcessScriptFile() { return value; }`,
  );
  const link = path.join(checkout, "node_modules/fixture-dependency");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let expected: Map<string, string> | undefined;
  for (const store of ["checkout/node_modules/.pnpm", "external-store"]) {
    const dependency = path.join(
      root,
      store,
      "fixture-dependency@1.0.0/node_modules/fixture-dependency",
    );
    put(path.join(dependency, "package.json"), '{"type":"module","main":"index.js"}');
    // A comment-like string must survive; only bundler provenance is disposable.
    put(
      path.join(dependency, "index.js"),
      'export const value = "// keep this /node_modules/path";',
    );
    fs.symlinkSync(dependency, link, "junction");
    const outputs = await writeRuntimeScriptAssets({ rootDir: checkout });
    if (expected) {
      expect(outputs).toEqual([]);
      for (const [output, contents] of expected) {
        expect(fs.readFileSync(path.join(checkout, output), "utf8")).toBe(contents);
      }
    } else {
      expected = new Map(
        outputs.map((output) => [output, fs.readFileSync(path.join(checkout, output), "utf8")]),
      );
      expect(expected.size).toBeGreaterThan(0);
      expect(expected.get("src/infra/update-state-sizes.generated.mjs")).toContain(
        "// keep this /node_modules/path",
      );
    }
    fs.unlinkSync(link);
  }
});
