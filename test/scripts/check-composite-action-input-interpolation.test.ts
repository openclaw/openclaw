import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const { createTempDir } = createScriptTestHarness();
const scriptPath = path.resolve("scripts/check-composite-action-input-interpolation.py");

function runCheck(actions: Record<string, string>) {
  const cwd = createTempDir("openclaw-composite-action-inputs-");
  writeFixtureFiles(
    path.join(cwd, ".github/actions"),
    Object.fromEntries(
      Object.entries(actions).map(([name, source]) => [`${name}/action.yml`, source]),
    ),
  );
  return spawnSync("python3", [scriptPath], {
    cwd,
    encoding: "utf8",
  });
}

it("rejects direct inputs interpolation inside composite run blocks", () => {
  const result = runCheck({
    unsafe: `name: unsafe
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        echo "\${{ inputs.token }}"`,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("Disallowed direct inputs interpolation");
  expect(result.stdout).toContain(".github/actions/unsafe/action.yml:7");
  expect(result.stdout).toContain("Use env: and reference shell variables instead.");
});

it.each([
  { name: "first step key", using: "composite", firstKey: true },
  { name: "double-quoted using", using: '"composite"', firstKey: false },
  { name: "single-quoted using", using: "'composite'", firstKey: false },
  { name: "quoted using with a comment", using: '"composite" # runtime', firstKey: true },
])("rejects direct interpolation with $name", ({ using, firstKey }) => {
  const result = runCheck({
    unsafe: `name: unsafe
runs:
  using: ${using}
  steps:
${
  firstKey
    ? '    - run: |\n        echo "${{ inputs.value }}"\n      shell: bash'
    : '    - shell: bash\n      run: echo "${{ inputs.value }}"'
}`,
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain(".github/actions/unsafe/action.yml:6");
  expect(result.stdout).toContain("Disallowed direct inputs interpolation");
});

it("allows env indirection and ignores non-composite actions", () => {
  const result = runCheck({
    safe: `name: safe
runs:
  using: composite
  steps:
    - run: |
        echo "$TOKEN"
      shell: bash
      env:
        TOKEN: \${{ inputs.token }}`,
    "non-composite": `name: non-composite
runs:
  using: node24
  main: dist/index.js
  steps:
    - run: echo "\${{ inputs.token }}"`,
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("No direct inputs interpolation found");
});
