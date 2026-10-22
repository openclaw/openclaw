import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { checkScriptErasability } from "../../scripts/check-script-erasability.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { createScriptTestHarness } from "./test-helpers.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const { createTempDir } = createScriptTestHarness();
const quietNode = "--disable-warning=ExperimentalWarning";

function checkNodeScriptErasability(root: string): ReturnType<typeof checkScriptErasability> {
  // Only Node's strip-only parser can prove this contract, even with a Bun test runner.
  const checkerUrl = new URL("../../scripts/check-script-erasability.mjs", import.meta.url).href;
  const program = `import { checkScriptErasability } from ${JSON.stringify(checkerUrl)};
       console.log(JSON.stringify(checkScriptErasability(process.argv[1])));`;
  const args = [quietNode, "--input-type=module", "--eval", program, root];
  return JSON.parse(execFileSync(requireNodeTool("node"), args, { encoding: "utf8" }));
}

function writeScriptsTree(files: Record<string, string>): string {
  const scriptsRoot = path.join(createTempDir("openclaw-script-erasability-"), "scripts");
  writeFixtureFiles(scriptsRoot, files);
  return scriptsRoot;
}

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
      "scripts/lib/managed-cleanup-handoff.mts",
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
      [quietNode, path.join(scriptsRoot, "check-script-erasability.mjs")],
      { encoding: "utf8", timeout: 10_000 },
    );
    const { error, status: exitStatus, stdout, stderr } = result;
    expect({ error, status: exitStatus }).toEqual({ error: undefined, status });
    if (status === 0) {
      expect({ stdout, stderr }).toEqual({
        stdout: "[script-erasability] checked 3 TypeScript implementation files\n",
        stderr: "",
      });
    } else {
      expect(stdout).toBe("");
      expect(stderr).toContain(
        "TypeScript syntax under scripts/ must be erasable by Node without transformation:",
      );
      expect(stderr).toContain(`- scripts/${file}:${line}: `);
      expect(stderr).toMatch(/enum.*strip-only/u);
    }
  },
);

it("accepts erasable annotations and enum-like string content", () => {
  const scriptsRoot = writeScriptsTree({
    "annotations.ts": `
        interface User { name: string }
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
