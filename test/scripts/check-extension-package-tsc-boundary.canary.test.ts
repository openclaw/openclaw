import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());

it.each([
  { code: 1, output: "TS6059 src/plugins/contracts/rootdir-boundary-canary.ts", pass: true },
  { code: 137, output: "TS6059 src/plugins/contracts/rootdir-boundary-canary.ts", pass: false },
  { code: 75, output: "TS6059 src/plugins/contracts/rootdir-boundary-canary.ts", pass: false },
  { code: 2, output: "TS6059 src/plugins/contracts/rootdir-boundary-canary.ts", pass: false },
  { code: 1, output: "TS6059 unrelated.ts", pass: false },
  { code: 1, output: "TS2307 src/plugins/contracts/rootdir-boundary-canary.ts", pass: false },
  { code: 0, output: "", pass: false },
  {
    code: "unjoined",
    output: "TS6059 src/plugins/contracts/rootdir-boundary-canary.ts",
    pass: false,
  },
  { code: "canceled", output: "", pass: false },
])("qualifies negative canary outcome $code / $output", ({ code, output, pass }) => {
  const root = fs.realpathSync(fixture.createTempDir("boundary-canary-outcome-"));
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  installDistArtifactScripts(
    root,
    ["check-extension-package-tsc-boundary.mts", "check-file-utils.ts"],
    {
      compiler: false,
      dependencies: ["tsx", "typescript", "@openclaw/fs-safe", "p-map"],
    },
  );
  for (const file of [
    "src/plugins/package-entrypoints.ts",
    "src/shared/non-packaged-plugin-dirs.ts",
  ]) {
    write(file, fs.readFileSync(path.resolve(file), "utf8"));
  }
  write("package.json", '{"type":"module"}');
  write("pnpm-workspace.yaml", "packages: []\n");
  write(
    "scripts/prepare-extension-package-boundary-artifacts.mts",
    "export async function prepareExtensionPackageBoundaryArtifacts() {}\n",
  );
  write("extensions/demo/tsconfig.json", '{"extends":"../tsconfig.package-boundary.base.json"}');
  // The real CLI and artifact owner consume synthetic, already-joined compiler outcomes.
  // No compiler or retained live process exists when this fixture removes its inputs.
  write(
    "scripts/lib/semantic-check-admission.mts",
    `
import fs from 'node:fs';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
export async function runSemanticCheck(options) {
  const child = new ChildProcess();
  Object.defineProperties(child, { stdout: { value: new PassThrough() }, stderr: { value: new PassThrough() } });
  options.onReady?.(child);
  child.stderr.emit('data', ${JSON.stringify(output)});
  const receipt = JSON.parse(options.args[1]).inputReceipt;
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, '{}');
  if (${JSON.stringify(code)} === 'unjoined') throw Object.assign(new Error('uncertain cleanup'), { processTreeState: 'indeterminate' });
  if (${JSON.stringify(code)} === 'canceled') throw new DOMException('queued cancellation', 'AbortError');
  return ${JSON.stringify(code)};
}
`,
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/check-extension-package-tsc-boundary.mts", "--mode=canary"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(pass ? 0 : 1);
  expect(result.stdout.includes("boundary check passed")).toBe(pass);
  if (!pass)
    expect(result.stderr.trim().split("\n").at(-1)).toBe("[package-boundary] FAILED (exit 1)");
  if (code === "canceled") {
    expect(result.stderr).toContain("queued cancellation");
    expect(result.stderr).toContain("kind: canceled");
    expect(result.stderr).not.toContain("only a getter");
  }
  for (const file of [
    "extensions/demo/__rootdir_boundary_canary__.ts",
    "extensions/demo/tsconfig.rootdir-canary.json",
    ".artifacts/extension-package-boundary/compile/demo-canary.inputs.json",
    ".artifacts/dist-artifacts.lock/owner.json",
    ".artifacts/dist-artifacts.lock/unjoined",
  ]) {
    expect(fs.existsSync(path.join(root, file)), file).toBe(code === "unjoined");
  }
});
