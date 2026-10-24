import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { createScriptTestHarness } from "./test-helpers.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const { createTempDir } = createScriptTestHarness();
const quietNode = "--disable-warning=ExperimentalWarning";

function runScripts(files: Record<string, string>) {
  const fixtureRoot = createTempDir("openclaw-script-erasability-");
  const scriptsRoot = path.join(fixtureRoot, "scripts");
  writeFixtureFiles(scriptsRoot, files);
  fs.copyFileSync("scripts/check-script-erasability.mjs", path.join(scriptsRoot, "check.mjs"));
  // The strip-only parser is a Node contract, not the test runner's transpiler.
  const result = spawnSync(
    requireNodeTool("node"),
    [quietNode, path.join(scriptsRoot, "check.mjs")],
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
        export const swift = \`enum GatewayEvent { case ready }\`;
        export const kotlin: string = "enum class GatewayEvent { Ready }";
      `,
    "types.d.ts": "declare enum RuntimeShape { Ready }",
    "dist/output.ts": "enum DistOutput { Ready }",
  });

  expect(result).toMatchObject({
    status: 0,
    stdout: "[script-erasability] checked 1 TypeScript implementation files\n",
    stderr: "",
  });
});

it("rejects transform-required syntax in deterministic file order", () => {
  const result = runScripts({
    "z/parameter-property.mts": "class Client { constructor(private token: string) {} }",
    "a-runtime-enum.cts": "enum State { Ready }",
  });

  expect(result).toMatchObject({ status: 1, stdout: "" });
  expect(result.stderr).toContain(
    "TypeScript syntax under scripts/ must be erasable by Node without transformation:",
  );
  expect(result.stderr.match(/- scripts\/[^\n]+/gu)).toEqual([
    expect.stringMatching(/^- scripts\/a-runtime-enum.cts:1: .*enum.*strip-only/u),
    expect.stringMatching(
      /^- scripts\/z\/parameter-property.mts:1: .*parameter property.*strip-only/u,
    ),
  ]);
});
