import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { TSGO_ROOT_TEST_SHARDS } from "../../scripts/lib/tsgo-core-test-shards.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";
import { overrideNativeFixtureExecutable } from "./native-boundary-fixture.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());

function readJsonLines<T>(file: string): T[] {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function fixture() {
  const root = fs.realpathSync(lifetime.createTempDir("tsgo-ci-continuation-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  installDistArtifactScripts(root, ["run-tsgo-core-test-shards.mts", "run-tsgo.mts"], {
    compiler: false,
  });
  const events = path.join(root, "compiler-events.jsonl");
  const compiler = path.join(root, "compiler.mjs");
  fs.writeFileSync(
    compiler,
    `#!/usr/bin/env node
import fs from "node:fs";
const config = process.argv[process.argv.indexOf("-p") + 1];
fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify(config) + "\\n");
console.log("src/fixture.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.");
process.exitCode = 2;
`,
  );
  fs.chmodSync(compiler, 0o755);
  if (process.platform === "win32") {
    fs.writeFileSync(`${compiler}.cmd`, `@"${process.execPath}" "%~dp0compiler.mjs" %*\r\n`);
  }
  overrideNativeFixtureExecutable(root, compiler);
  return {
    root,
    run: (args: string[], signal: AbortSignal, env = process.env) =>
      lifetime.track(
        runNodeScript(
          [path.join(root, "scripts/run-tsgo-core-test-shards.mts"), ...args],
          env,
          undefined,
          { cwd: root, signal, requireProcessTreeExit: true },
        ),
      ),
    wrapperEnv: (source: string, replacement: string) =>
      preparedScriptWrapperEnv(
        [],
        { ...process.env, CI: "true", OPENCLAW_LOCAL_CHECK: "0", OPENCLAW_CI_STATIC_EVIDENCE: "1" },
        [[pathToFileURL(path.join(root, source)), pathToFileURL(replacement)]],
      ),
    events: () => readJsonLines<string>(events),
  };
}

it.for([
  { name: "retry without evidence", ci: "true", evidence: "0", expected: 4 },
  { name: "CI evidence", ci: "true", evidence: "1", expected: 4 },
  { name: "local fail-fast", ci: "", evidence: "0", expected: 1 },
])(
  "reports all root partition failures on $name",
  async ({ ci, evidence, expected }, { signal }) => {
    const f = fixture();
    const result = await f.run(["--ci-graphs-json", '["test-root"]'], signal, {
      ...process.env,
      CI: ci,
      GITHUB_ACTIONS: "",
      GITHUB_RUN_ATTEMPT: "2",
      OPENCLAW_LOCAL_CHECK: "0",
      OPENCLAW_CI_STATIC_EVIDENCE: evidence,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(2);
    expect(f.events()).toEqual(
      TSGO_ROOT_TEST_SHARDS.slice(0, expected).map((shard) => shard.config),
    );
    expect(result.stdout.includes('"planned":4,"completed":4')).toBe(
      ci === "true" && evidence === "1" && process.platform !== "win32",
    );
  },
);

it("runs changed-path types after boundary validation fails", async ({ signal }) => {
  const f = fixture();
  const boundary = path.join(f.root, "boundary.mjs");
  fs.writeFileSync(
    boundary,
    `export class CoreTsgoBoundaryInterruptedError extends Error {}
export async function checkCoreTsgoGraphBoundary() { throw new Error("fixture boundary failure"); }
`,
  );
  const env = f.wrapperEnv("scripts/check-tsgo-core-boundary.mts", boundary);
  const result = await f.run(
    ["--changed-paths-json", '["src/fixture.test.ts"]', "--stripe", "1/5"],
    signal,
    env,
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("fixture boundary failure");
  expect(result.stdout).toContain("error TS2322");
  expect(f.events().length).toBeGreaterThan(1);
});

it("keeps the watchdog stop when CI drains ordinary failures", async ({ signal }) => {
  const f = fixture();
  const managed = path.join(f.root, "managed.mjs");
  const calls = path.join(f.root, "managed-calls.json");
  fs.writeFileSync(
    managed,
    `export * from ${JSON.stringify(new URL("../../scripts/lib/managed-child-process.mts", import.meta.url).href)};
import fs from "node:fs";
export async function runManagedCommand(command) {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(command.args) + "\\n");
  throw Object.assign(new Error("fixture watchdog expired"), { code: "ETIMEDOUT" });
}
`,
  );
  const env = f.wrapperEnv("scripts/lib/managed-child-process.mts", managed);
  const result = await f.run(["--ci-graphs-json", '["test-root"]'], signal, env);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("killed the tsgo process tree");
  const commands = readJsonLines<string[]>(calls);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain(TSGO_ROOT_TEST_SHARDS[0].config);
  expect(result.stdout).not.toContain("[ci-static:tsgo:completion]");
});
