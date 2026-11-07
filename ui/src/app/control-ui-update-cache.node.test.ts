// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.ts";
import { controlUiUpdateCachePlugins } from "../../config/control-ui-update-cache.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps updated imports cache-stable without reusing changed immutable assets", async () => {
  const root = tempDirs.make("control-ui-update-cache-");
  async function fixture(
    options: {
      leaf?: number;
      color?: string;
      extraCss?: boolean;
      cssCodeSplit?: boolean;
      runtimeEdition?: number;
    } = {},
  ) {
    const files = {
      "index.html":
        '<html><head></head><body><script type="module" src="./entry.js"></script></body></html>',
      "entry.js":
        'import { load } from "./connection.js"; globalThis.loadLeaf = load; globalThis.loadLocale = () => import("./locale.js");',
      "connection.js": 'export const load = () => import("./leaf.js");',
      "leaf.js": `${options.extraCss ? 'import "./extra.css";' : ""} import "./leaf.css"; export const value = ${options.leaf ?? 1};`,
      "leaf.css": `body { color: ${options.color ?? "red"}; }`,
      "extra.css": "body { background: blue; }",
      "locale.js": 'export const greeting = "hello";',
    };
    await Promise.all(
      Object.entries(files).map(([name, source]) => fs.writeFile(path.join(root, name), source)),
    );
    const result = await build({
      root,
      base: "./",
      configFile: false,
      publicDir: false,
      logLevel: "silent",
      plugins: [
        {
          name: "fixture-runtime-edition",
          enforce: "pre",
          renderChunk(code, chunk) {
            return chunk.name === "rolldown-runtime"
              ? {
                  code: `${code}\nglobalThis.fixtureRuntimeEdition=${options.runtimeEdition ?? 1};`,
                  map: null,
                }
              : null;
          },
        },
        ...controlUiUpdateCachePlugins(),
      ],
      build: {
        write: false,
        cssCodeSplit: options.cssCodeSplit,
        modulePreload: { polyfill: false },
        rolldownOptions: {
          preserveEntrySignatures: "allow-extension",
          output: {
            strictExecutionOrder: true,
            codeSplitting: {
              groups: [
                {
                  name: "control-ui-connection",
                  test: /\/connection\.js$/u,
                  includeDependenciesRecursively: false,
                },
                {
                  name: "control-ui-boot-shared",
                  test: /\/leaf\.js$/u,
                  includeDependenciesRecursively: false,
                },
              ],
            },
          },
        },
      },
    });
    if (Array.isArray(result) || !("output" in result))
      throw new Error("Expected one fixture build");
    const chunks = result.output.filter((item) => item.type === "chunk");
    const html = result.output.find((item) => item.fileName === "index.html");
    if (html?.type !== "asset") throw new Error("Expected fixture HTML");
    const encoded = /<script\b[^>]*type="importmap"[^>]*>(.*?)<\/script>/su.exec(
      String(html.source),
    )?.[1];
    if (!encoded) throw new Error("Expected production import map");
    const imports: Record<string, string> = JSON.parse(encoded).imports;
    const entry = chunks.find((chunk) => chunk.isEntry);
    const connection = chunks.find((chunk) => chunk.name === "control-ui-connection");
    const locale = chunks.find((chunk) => chunk.moduleIds.includes(path.join(root, "locale.js")));
    if (!entry || !connection || !locale) throw new Error("Expected fixture chunks");
    return { chunks, imports, entry, connection, locale };
  }

  const original = await fixture();
  const leaf = await fixture({ leaf: 2 });
  const css = await fixture({ color: "green" });
  const expanded = await fixture({ extraCss: true });
  const extraction = await fixture({ cssCodeSplit: false });
  const runtime = await fixture({ runtimeEdition: 2 });

  for (const changed of [leaf, css]) {
    expect(changed.entry.fileName).toBe(original.entry.fileName);
    expect(changed.entry.code).toBe(original.entry.code);
    expect(changed.connection.fileName).toBe(original.connection.fileName);
    expect(changed.connection.code).toBe(original.connection.code);
  }
  const cssEntry = Object.entries(css.imports).find(([, value]) => value.endsWith(".css"));
  expect(cssEntry).toBeDefined();
  expect(css.connection.code).toContain(path.posix.basename(cssEntry![0]));
  expect(css.imports).not.toEqual(original.imports);
  expect(expanded.locale.fileName).toBe(original.locale.fileName);
  expect(expanded.locale.code).toBe(original.locale.code);
  expect(Object.values(runtime.imports).some((file) => file.includes("rolldown-runtime"))).toBe(
    false,
  );
  expect(runtime.connection.fileName).not.toBe(original.connection.fileName);

  // A collision would poison the immutable browser cache even when a reload works.
  const builds = [original, leaf, css, expanded, extraction, runtime];
  for (const before of builds) {
    for (const after of builds) {
      const byName = new Map(before.chunks.map((chunk) => [chunk.fileName, chunk.code]));
      for (const chunk of after.chunks) {
        if (byName.has(chunk.fileName)) expect(chunk.code).toBe(byName.get(chunk.fileName));
      }
    }
  }
});
