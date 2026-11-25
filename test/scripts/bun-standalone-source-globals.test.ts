import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStandaloneSourceGlobals } from "../../scripts/lib/bun-standalone-source-globals.mjs";
import { collectNativeTypeScriptDiagnostics } from "../../scripts/lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

describe("standalone source global declarations", () => {
  it("preserves import results, Node require types, and the actual image metadata contracts", () => {
    const root = path.resolve(".artifacts", "standalone-source-globals-fixture");
    using session = createNativeTypeScriptProject({
      cwd: root,
      configFileName: "tsconfig.json",
      files: {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "nodenext",
            target: "esnext",
            types: ["node"],
          },
          files: ["globals.d.ts", "consumer.ts"],
        }),
        "globals.d.ts": createStandaloneSourceGlobals(),
        "consumer.ts": `import { createRequire } from "node:module";
import fs from "node:fs";
const namespace = await globalThis.__openclawStandaloneImport("file:///main.ts", "./target.js", undefined, () => import("./target.js"));
const count: number = namespace.count;
// @ts-expect-error A relocated import retains its real namespace.
const wrong: string = namespace.count;
// @ts-expect-error Unknown namespace members must not become any.
namespace.missing;
const require = globalThis.__openclawStandaloneCreateRequire(createRequire, import.meta.url);
const resolved: string = require.resolve("node:fs");
const paths: string[] | null = require.resolve.paths("node:fs");
const cache: NodeJS.Require["cache"] = require.cache;
// @ts-expect-error createRequire retains Node's original specifier contract.
require.resolve(123);
const opened = globalThis.__openclawStandaloneModuleOpen({ rootPath: "/runtime", filePath: "/runtime/entry.js", rejectHardlinks: true });
if (opened) {
  const ok: true = opened.ok;
  const exists: true = opened.exists;
  // @ts-expect-error Image facts do not manufacture a file descriptor.
  opened.fd;
}
const file = globalThis.__openclawStandaloneImageRead({ rootDir: "/runtime", relativePath: "entry.js", maxBytes: 100 });
if (file) { const bytes: Buffer = file.contents; const hash: string = file.hash; }
const entries: fs.Dirent[] = globalThis.__openclawStandaloneImageDirectory("/runtime", () => fs.readdirSync("/runtime", { withFileTypes: true }));
const loaded = globalThis.__openclawStandaloneLoadPluginModule("/runtime/plugin.js");
if (loaded) {
  // @ts-expect-error Dynamic CJS exports have no inferred module namespace.
  loaded.moduleExport.missing;
}
declare const capture: (root: string, selected?: string | readonly string[]) => {
  rootDir: string; sourceRoot: string; hasSource(source: string): boolean;
  resolve(source: string, rejectHardlinks?: boolean): string; prepareModule(filename: string): string[];
  linkHost(hostRoot: string): void; dispose(): void; disposeAsync(): Promise<void>;
};
const artifact = globalThis.__openclawStandaloneCaptureOperationArtifact(capture, "/runtime", ["/runtime/op.js"]);
const prepared: string[] = artifact.prepareModule("/runtime/op.js");
// @ts-expect-error The image capture implements the operation contract, not full source custody.
artifact.sourceRoot;
export {};
`,
        "target.ts": "export const count = 1;",
        "package.json": '{ "type": "module" }',
      },
    });
    expect(collectNativeTypeScriptDiagnostics(session.project)).toEqual([]);
  });
});
