import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type TsdownPlugin } from "tsdown";
import { expect, it } from "vitest";
import { createEmptyCompanionChunksPlugin } from "../../scripts/lib/empty-companion-chunks.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it.each(["bare", "dynamic", "named", "reexport", "effect", "await", "text"])(
  "only removes semantically empty bare-import companions: %s",
  async (kind) => {
    const root = createTempDir("empty-companion-");
    fs.writeFileSync(path.join(root, "shared.ts"), "globalThis.fixtureSideEffect = true;");
    for (const name of ["a", "b"]) {
      fs.writeFileSync(
        path.join(root, name + ".ts"),
        'import "./shared.js"; export const value = 42;',
      );
    }
    fs.writeFileSync(path.join(root, "empty.ts"), "export {};");
    let companion = "";
    let before = "";
    // Model the compiler's emitted no-op boundary, including references that must
    // prevent removal. The complete canonical graph separately reproduces its creation.
    const fixture: TsdownPlugin = {
      name: "emitted-companion-fixture",
      generateBundle: {
        order: "pre",
        handler(_options, bundle) {
          const shared = Object.values(bundle).find((c) => c.type === "chunk" && !c.isEntry);
          if (!shared || shared.type !== "chunk") {
            throw new Error("Missing shared fixture chunk");
          }
          companion = shared.fileName;
          shared.code =
            kind === "effect"
              ? "globalThis.sideEffect = true; export {};"
              : kind === "await"
                ? "await Promise.resolve(); export {};"
                : "export {};\n";
          for (const entry of Object.values(bundle)) {
            if (entry.type !== "chunk" || !entry.isEntry || entry.name === "empty") {
              continue;
            }
            const source = JSON.stringify("./" + shared.fileName);
            entry.code =
              kind === "dynamic"
                ? "export const value = import(" + source + ");"
                : kind === "named"
                  ? "import * as namespace from " + source + "; export { namespace };"
                  : kind === "reexport"
                    ? "export * from " + source + ";"
                    : kind === "text"
                      ? "export const text = " + JSON.stringify("import " + source + ";") + ";"
                      : "import " + source + ";\nexport const value = await Promise.resolve(42);\n";
            entry.imports = kind === "dynamic" ? [] : [companion];
            entry.dynamicImports = kind === "dynamic" ? [companion] : [];
            before = entry.code;
          }
        },
      },
    };
    const { bundles } = await build({
      entry: {
        a: path.join(root, "a.ts"),
        b: path.join(root, "b.ts"),
        empty: path.join(root, "empty.ts"),
      },
      outDir: path.join(root, "dist"),
      config: false,
      dts: false,
      sourcemap: true,
      platform: "node",
      format: "esm",
      unbundle: false,
      logLevel: "silent",
      plugins: [fixture, createEmptyCompanionChunksPlugin()],
    });
    try {
      const chunks = bundles.flatMap((b) => b.chunks).filter((c) => c.type === "chunk");
      expect(chunks.some((c) => c.fileName === companion)).toBe(kind !== "bare");
      const entries = chunks.filter((c) => c.isEntry);
      expect(entries).toHaveLength(3);
      expect(entries.find((entry) => entry.name === "empty")?.code.trim()).toMatch(
        /^export\s*\{\s*\};?/,
      );
      for (const entry of entries.filter((candidate) => candidate.name !== "empty")) {
        if (kind === "bare") {
          expect(entry.imports).toEqual([]);
          expect(entry.code.length).toBe(before.length);
          expect(entry.code.split("\n")).toHaveLength(before.split("\n").length);
          expect(entry.code).toContain("await Promise.resolve(42)");
          const imported = await import(
            pathToFileURL(path.join(root, "dist", entry.fileName)).href
          );
          expect(imported.value).toBe(42);
        } else {
          expect(entry.code).toBe(before);
        }
      }
    } finally {
      for (const bundle of bundles) {
        await bundle[Symbol.asyncDispose]();
      }
    }
  },
);
