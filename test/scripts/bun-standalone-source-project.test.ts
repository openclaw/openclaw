import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createStandaloneSourceProject } from "../../scripts/lib/bun-standalone-source-project.mjs";
import { collectNativeTypeScriptDiagnostics } from "../../scripts/lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "../../scripts/lib/native-typescript.mts";

describe("standalone native source project", () => {
  it.each(["explicit", "implicit"])(
    "retains %s ambient types, inherited includes, and strict checking across staging",
    (kind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-source-project-"));
      try {
        const sourceRoot = path.join(root, "source");
        const outputRoot = path.join(root, "output");
        const runtimeRoot = path.join(outputRoot, "runtime");
        const config = path.join(outputRoot, "tsconfig.json");
        const entry = path.join(runtimeRoot, ".typed-source", "context", "entry.ts");
        const helper = path.join(outputRoot, "workers", "helper.mjs");
        const dependency = path.join(sourceRoot, "src", "dependency.ts");
        const configs: Array<[string, string]> = [
          [
            path.join(sourceRoot, "base.json"),
            JSON.stringify({
              compilerOptions: kind === "explicit" ? { typeRoots: ["types"] } : {},
            }),
          ],
          [
            path.join(sourceRoot, "tsconfig.json"),
            JSON.stringify({
              extends: "./base.json",
              compilerOptions: {
                strict: true,
                noUncheckedIndexedAccess: true,
                noEmit: true,
                declaration: true,
                outDir: "build/types",
                target: "esnext",
                module: "nodenext",
                types: ["fixture"],
              },
              include: ["src/**/*"],
            }),
          ],
        ];
        const files = {
          ...Object.fromEntries(configs),
          [path.join(sourceRoot, "package.json")]: '{"type":"module"}',
          [path.join(runtimeRoot, "package.json")]: '{"type":"module"}',
          [path.join(
            sourceRoot,
            ...(kind === "explicit" ? ["types"] : ["node_modules", "@types"]),
            "fixture",
            "index.d.ts",
          )]: "declare interface ConfiguredAmbient {value: number}",
          [path.join(sourceRoot, "src", "ambient.d.ts")]:
            "declare interface IncludedAmbient {name: string}",
          [dependency]: "export const value: number = 42;",
          [helper]: "// @ts-check\n/** @type {number} */ export const helperValue = 7;",
          [path.join(sourceRoot, "src", "unreferenced.ts")]:
            "export const optional: string | undefined = undefined;",
          [entry]: `import {value} from ${JSON.stringify(path.relative(path.dirname(entry), dependency).replace(/\\/g, "/").replace(/\.ts$/, ".js"))};
export function read(input: ConfiguredAmbient & IncludedAmbient): number {return input.value + input.name.length + value;}
export function optional(values: Record<string, string>, key: string): string | undefined {let value = values[key]; value = undefined; return value;}`,
        };
        for (const [filename, contents] of configs) {
          fs.mkdirSync(path.dirname(filename), { recursive: true });
          fs.writeFileSync(filename, contents);
        }
        const project = createStandaloneSourceProject({
          sourceRoot,
          runtimeRoot,
          projectFile: config,
          entrypoints: [entry, helper],
        });
        function diagnostics(configContents: object, additions: Record<string, string> = {}) {
          using session = createNativeTypeScriptProject({
            cwd: root,
            configFileName: config,
            files: { ...files, [config]: JSON.stringify(configContents), ...additions },
          });
          return collectNativeTypeScriptDiagnostics(session.project);
        }
        const { compilerOptions: _rootDir, ...before } = project;
        expect(diagnostics(before).some((diagnostic) => diagnostic.code === 6059)).toBe(true);
        expect(
          diagnostics({
            ...project,
            compilerOptions: { ...project.compilerOptions, allowJs: false },
          }).some((diagnostic) => diagnostic.code === 6504),
        ).toBe(true);
        expect(diagnostics(project)).toEqual([]);
        expect(
          diagnostics(project, {
            [helper]: '// @ts-check\n/** @type {number} */ export const helperValue = "invalid";',
          }).map((diagnostic) => ({ code: diagnostic.code, file: diagnostic.fileName })),
        ).toContainEqual({ code: 2322, file: helper.split(path.sep).join("/") });
        const invalidIncluded = path.join(sourceRoot, "src", "unreferenced.ts");
        expect(
          diagnostics(project, {
            [invalidIncluded]:
              "const optional: string | undefined = undefined; export const strict: string = optional;",
          }).map((diagnostic) => ({ code: diagnostic.code, file: diagnostic.fileName })),
        ).toContainEqual({ code: 2322, file: invalidIncluded.split(path.sep).join("/") });
        const invalidAmbient = path.join(
          sourceRoot,
          ...(kind === "explicit" ? ["types"] : ["node_modules", "@types"]),
          "fixture",
          "index.d.ts",
        );
        expect(
          diagnostics(project, {
            [invalidAmbient]: "declare interface ConfiguredAmbient {value: string}",
          }).some(
            (diagnostic) =>
              diagnostic.code === 2322 && diagnostic.fileName === entry.split(path.sep).join("/"),
          ),
        ).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
