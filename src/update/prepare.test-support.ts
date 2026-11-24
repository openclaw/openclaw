import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, vi } from "vitest";
import * as openclawRoot from "../infra/openclaw-root.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";

const exec = promisify(execFile);
export let root: string;
export let bin: string;
export let node: string;
const originalPath = process.env.PATH;

export async function executable(name: string, source: string) {
  const file = path.join(bin, name);
  await fs.writeFile(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return file;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prepare-"));
  bin = path.join(root, "bin");
  await fs.mkdir(bin);
  node = path.join(bin, "node");
  await fs.symlink(process.execPath, node);
  vi.stubEnv("PATH", `${bin}${path.delimiter}${originalPath}`);
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file === "/.dockerenv") {
      throw Object.assign(new Error("No container marker in this fixture"), { code: "ENOENT" });
    }
    return access(file, mode);
  });
  for (const key of ["container", "DOCKER_CONTAINER", "OPENCLAW_CONTAINER", "IN_NIX_SHELL"]) {
    vi.stubEnv(key, "");
  }
  // Every update reclaims earlier updaters' runtimes; keep that scan inside this fixture.
  const tmp = path.join(root, "tmp");
  await fs.mkdir(tmp);
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, tmp);
  }
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.spyOn(openclawRoot, "resolveOpenClawPackageRootsSync").mockReturnValue([]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

export async function repository(
  failBuild = false,
  engine = ">=1",
  releaseAware = false,
  schemaVersions?: OpenClawSchemaVersions,
  pluginCommand = "console.log(JSON.stringify({status:'ok',changed:false,warnings:[],sync:{warnings:[],errors:[]},npm:{outcomes:[]}}));",
  version = "2026.11.21",
) {
  const source = path.join(root, "source");
  const bare = path.join(root, "remote.git");
  const checkout = path.join(root, "checkout");
  await fs.mkdir(source);
  const git = (...args: string[]) => exec("git", ["-C", source, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.email", "prepare@example.invalid");
  await git("config", "user.name", "Prepare Fixture");
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version,
      engines: { node: engine },
      scripts: { build: "node build.cjs", "ui:build": "node ui.cjs" },
      ...(schemaVersions ? { openclaw: { schemaVersions } } : {}),
    }),
  );
  await fs.writeFile(path.join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (releaseAware) {
    await fs.mkdir(path.join(source, "src", "update"), { recursive: true });
    await fs.writeFile(path.join(source, "src", "update", "check-release.ts"), "");
  }
  await fs.writeFile(
    path.join(source, "openclaw.mjs"),
    `import { spawnSync } from 'node:child_process';
    import fs from 'node:fs';
    if (process.argv[3] === 'check-release') {
      ${releaseAware ? "console.log(JSON.stringify({ok:true,surfaces:[]}));" : "throw new Error('unsupported command');"}
    } else { ${pluginCommand} }`,
  );
  await fs.writeFile(
    path.join(source, "build.cjs"),
    failBuild
      ? "process.stderr.write('\\x1b[33mwarning: build notice\\x1b[0m\\n'.repeat(400) + '\\x1b[31mfixture build failed\\x1b[0m\\n'); process.exit(42);"
      : "const fs=require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/build-info.json', JSON.stringify({buildId:'fixture-build'}));",
  );
  await fs.writeFile(
    path.join(source, "ui.cjs"),
    "require('node:fs').writeFileSync('dist/ui-built', 'ready');",
  );
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await exec("git", ["clone", "--bare", source, bare]);
  await exec("git", ["clone", bare, checkout]);
  const sha = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  await executable(
    "pnpm",
    `
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('10.0.0'); process.exit(0); }
fs.appendFileSync('steps.txt', args.join(' ') + '\\n');
if (args[0] === 'install') {
  if (args.join(' ') !== 'install --frozen-lockfile') process.exit(9);
  process.exit(0);
}
const pkg = JSON.parse(fs.readFileSync('package.json'));
const result = cp.spawnSync(pkg.scripts[args[0]], {shell:true, stdio:'inherit'});
process.exit(result.status ?? 1);
`,
  );
  return { checkout, sha };
}
