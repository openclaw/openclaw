// Script erasability tests cover Node's transformation-free TypeScript boundary.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { checkScriptErasability } from "../../scripts/check-script-erasability.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function checkNodeScriptErasability(root: string): ReturnType<typeof checkScriptErasability> {
  // Only Node's strip-only parser can prove this contract, even with a Bun test runner.
  const checkerUrl = new URL("../../scripts/check-script-erasability.mjs", import.meta.url).href;
  const output = execFileSync(
    requireNodeTool("node"),
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "--eval",
      `import { checkScriptErasability } from ${JSON.stringify(checkerUrl)};
       console.log(JSON.stringify(checkScriptErasability(process.argv[1])));`,
      root,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

function writeScriptsTree(files: Record<string, string>): string {
  const scriptsRoot = path.join(createTempDir("openclaw-script-erasability-"), "scripts");
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(scriptsRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return scriptsRoot;
}

describe("check-script-erasability", () => {
  it.each([
    { file: "input.ts", source: "export const value: string = 'ready';", status: 0 },
    { file: "input.ts", source: "enum State { Ready }", status: 1 },
    { file: "lib/local-check-runtime.mts", source: "enum State { Ready }", status: 1 },
  ])(
    "preserves CLI diagnostics for $file and exit status $status on the current runtime",
    ({ file, source, status }) => {
      const scriptsRoot = writeScriptsTree({ "input.ts": "" });
      const fixtureRoot = path.dirname(scriptsRoot);
      for (const relativePath of [
        "scripts/check-script-erasability.mjs",
        "scripts/lib/tsx-cli-shim.mjs",
        "scripts/lib/local-check-runtime.mts",
        "src/infra/node-runtime-executable.ts",
      ]) {
        const destination = path.join(fixtureRoot, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.resolve(relativePath), destination);
      }
      const sourcePath = path.join(scriptsRoot, file);
      const existingSource = fs.readFileSync(sourcePath, "utf8");
      const prefix = existingSource ? `${existingSource}\n` : "";
      const line = prefix.split("\n").length;
      fs.writeFileSync(sourcePath, `${prefix}${source}\n`);
      const result = spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          path.join(scriptsRoot, "check-script-erasability.mjs"),
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(result.error).toBeUndefined();
      if (status === 0) {
        expect(result.stdout).toBe(
          "[script-erasability] checked 2 TypeScript implementation files\n",
        );
        expect(result.stderr).toBe("");
      } else {
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(
          "TypeScript syntax under scripts/ must be erasable by Node without transformation:",
        );
        expect(result.stderr).toContain(`- scripts/${file}:${line}: `);
        expect(result.stderr).toMatch(/enum.*strip-only/u);
      }
      expect(result.status).toBe(status);
    },
  );

  it("accepts erasable annotations and enum-like string content", () => {
    const scriptsRoot = writeScriptsTree({
      "annotations.ts": `
        interface User { name: string }
        const user: User = { name: "Ada" };
        export function nameOf(value: User): string { return value.name; }
      `,
      "generated-text.mts": `
        export const swift = \`enum GatewayEvent { case ready }\`;
        export const kotlin: string = "enum class GatewayEvent { Ready }";
      `,
      "types.d.ts": "declare enum RuntimeShape { Ready }",
      "build/output.ts": "enum BuiltOutput { Ready }",
      "dist/output.ts": "enum DistOutput { Ready }",
      "generated/output.ts": "enum GeneratedOutput { Ready }",
      "node_modules/example/index.ts": "enum DependencyOutput { Ready }",
    });

    expect(checkNodeScriptErasability(scriptsRoot)).toEqual({ checkedFiles: 2, errors: [] });
  });

  it("rejects transform-required syntax in deterministic file order", () => {
    const scriptsRoot = writeScriptsTree({
      "z-parameter-property.ts": "class Client { constructor(private token: string) {} }",
      "a-runtime-enum.cts": "enum State { Ready }",
    });

    const result = checkNodeScriptErasability(scriptsRoot);

    expect(result.checkedFiles).toBe(2);
    expect(result.errors.map(({ file, line }) => ({ file, line }))).toEqual([
      { file: "scripts/a-runtime-enum.cts", line: 1 },
      { file: "scripts/z-parameter-property.ts", line: 1 },
    ]);
    expect(result.errors[0]?.message).toMatch(/enum.*strip-only/u);
    expect(result.errors[1]?.message).toMatch(/parameter property.*strip-only/u);
  });

  it("accepts the repository scripts tree", () => {
    const scriptsRoot = path.resolve(import.meta.dirname, "../../scripts");
    const result = checkNodeScriptErasability(scriptsRoot);

    expect(result.checkedFiles).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });
});
