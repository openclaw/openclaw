import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const { createTempDir } = createScriptTestHarness();
const quietNode = "--disable-warning=ExperimentalWarning";

function runScripts(files: Record<string, string>) {
  const fixtureRoot = createTempDir("openclaw-script-erasability-");
  for (const relativePath of [
    "node-runtime-env.mjs",
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
  const scriptsRoot = path.join(fixtureRoot, "scripts");
  for (const [file, source] of Object.entries(files)) {
    const sourcePath = path.join(scriptsRoot, file);
    if (!fs.existsSync(sourcePath)) {
      writeFixtureFiles(scriptsRoot, { [file]: source });
      continue;
    }
    const existingSource = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(sourcePath, `${existingSource}\n${source}\n`);
  }
  const result = spawnSync(
    process.execPath,
    [quietNode, path.join(scriptsRoot, "check-script-erasability.mjs")],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  return result;
}

it("accepts erasable annotations and enum-like string content", () => {
  const result = runScripts({
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

  expect(result).toMatchObject({
    status: 0,
    stdout: "[script-erasability] checked 4 TypeScript implementation files\n",
    stderr: "",
  });
});

it("rejects transform-required syntax in deterministic file order", () => {
  const result = runScripts({
    "z-parameter-property.ts": "class Client { constructor(private token: string) {} }",
    "a-runtime-enum.cts": "enum State { Ready }",
  });

  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain(
    "TypeScript syntax under scripts/ must be erasable by Node without transformation:",
  );
  expect(result.stderr.match(/- scripts\/[^\n]+/gu)).toEqual([
    expect.stringMatching(/^- scripts\/a-runtime-enum.cts:1: .*enum.*strip-only/u),
    expect.stringMatching(
      /^- scripts\/z-parameter-property.ts:1: .*parameter property.*strip-only/u,
    ),
  ]);
});

it("reports a non-erasable runtime dependency without failing before the CLI diagnostic", () => {
  const source = fs.readFileSync("scripts/lib/local-check-runtime.mts", "utf8");
  const line = `${source}\n`.split("\n").length;
  const result = runScripts({ "lib/local-check-runtime.mts": "enum State { Ready }" });
  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain(`- scripts/lib/local-check-runtime.mts:${line}: `);
  expect(result.stderr).toMatch(/enum.*strip-only/u);
});
