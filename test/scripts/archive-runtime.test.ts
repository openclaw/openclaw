import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const fixture = fileURLToPath(new URL("./archive-runtime.test-support.mjs", import.meta.url));
const { createTempDir } = createScriptTestHarness();

describe("archive compression without global Buffer mutation", () => {
  it.each(["esm", "commonjs"])("round-trips tar archives through the %s entry", (entry) => {
    const output = execFileSync(
      resolveTestNodeExecPath(),
      [fixture, ...(entry === "commonjs" ? ["--commonjs"] : [])],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(output).toBe("archive round trip passed\n");
  });

  it("ships the repaired archive runtime without loading installed dependencies", async () => {
    const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
    const selected = configs.find(
      (config) =>
        config.entry &&
        typeof config.entry === "object" &&
        !Array.isArray(config.entry) &&
        "plugins/runtime/index" in config.entry,
    );
    if (!selected) {
      throw new Error("Missing unified runtime build config");
    }
    const root = fs.realpathSync(createTempDir("openclaw-archive-runtime-"));
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    const { bundles } = await build({
      ...selected,
      config: false,
      entry: { archive: fixture },
      outDir: root,
      dts: false,
      sourcemap: false,
      logLevel: "silent",
    });
    try {
      const entryUrl = pathToFileURL(path.join(root, "archive.js")).href;
      const outputRootUrl = pathToFileURL(`${root}${path.sep}`).href;
      const script = `
        import { isBuiltin, registerHooks } from "node:module";
        const entry = ${JSON.stringify(entryUrl)};
        const outputRoot = ${JSON.stringify(outputRootUrl)};
        registerHooks({ resolve(specifier, context, next) {
          const resolved = next(specifier, context);
          if (!isBuiltin(resolved.url) && !resolved.url.startsWith(outputRoot)) {
            throw new Error("Archive runtime loaded an external dependency: " + specifier);
          }
          return resolved;
        }});
        await import(entry);
      `;
      expect(
        execFileSync(resolveTestNodeExecPath(), ["--input-type=module", "--eval", script], {
          cwd: root,
          encoding: "utf8",
          timeout: 10_000,
        }),
      ).toBe("archive round trip passed\n");
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  });
});
