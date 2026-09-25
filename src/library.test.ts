// Tests library entrypoint exports and package boundary behavior.
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { collectModuleReferencesFromSource } from "../scripts/lib/guard-inventory-utils.mjs";
import { createNativeTypeScriptParser } from "../scripts/lib/native-typescript.mts";
import { loadSessionStore, saveSessionStore } from "./library.js";

const libraryPath = new URL("./library.ts", import.meta.url);
const lazyRuntimeSpecifiers = [
  "./auto-reply/reply.runtime.js",
  "./cli/prompt.js",
  "./infra/binaries.js",
  "./process/exec.js",
  "./plugins/runtime/runtime-web-channel-plugin.js",
] as const;

function readLibraryModuleImports(sourceText = readFileSync(libraryPath, "utf8")) {
  const { code } = transformSync(sourceText, {
    loader: "ts",
    format: "esm",
    target: "esnext",
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
  });
  const staticImports = new Set<string>();
  const dynamicImports = new Set<string>();
  const parser = createNativeTypeScriptParser();
  try {
    const sourceFile = parser.parseSourceFile("library.mjs", code);
    for (const { kind, specifier } of collectModuleReferencesFromSource(sourceFile)) {
      if (kind === "import" || kind === "export") {
        staticImports.add(specifier);
      } else if (kind === "dynamic-import") {
        dynamicImports.add(specifier);
      }
    }
  } finally {
    parser.close();
  }
  return { dynamicImports, staticImports };
}

describe("library module imports", () => {
  it("distinguishes runtime module edges from erased types", () => {
    const { dynamicImports, staticImports } = readLibraryModuleImports(`
      import "./side-effect.js";
      import type { TypeOnly } from "./type-only.js";
      import { value } from "./value.js";
      export { reexported } from "./reexported.js";
      export type { ExportType } from "./export-type.js";
      type Query = import("./type-query.js").Query;
      const lazy = () => import("./dynamic.js");
    `);

    expect([...staticImports]).toEqual(["./side-effect.js", "./value.js", "./reexported.js"]);
    expect([...dynamicImports]).toEqual(["./dynamic.js"]);
  });

  it("keeps lazy runtime boundaries on dynamic imports", () => {
    const { dynamicImports, staticImports } = readLibraryModuleImports();

    for (const specifier of lazyRuntimeSpecifiers) {
      expect(staticImports.has(specifier), `${specifier} should stay lazy`).toBe(false);
      expect(dynamicImports.has(specifier), `${specifier} should remain dynamically imported`).toBe(
        true,
      );
    }
  });

  it("keeps the deprecated root session-store wrappers uncached", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-library-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    try {
      await saveSessionStore(
        storePath,
        {
          "agent:main:main": { sessionId: "first", updatedAt: Date.now() },
        },
        { skipMaintenance: true },
      );
      expect(loadSessionStore(storePath)["agent:main:main"]?.sessionId).toBe("first");

      fs.writeFileSync(
        storePath,
        JSON.stringify({ "agent:main:main": { sessionId: "second", updatedAt: 2 } }),
      );
      expect(loadSessionStore(storePath)["agent:main:main"]?.sessionId).toBe("second");
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});
