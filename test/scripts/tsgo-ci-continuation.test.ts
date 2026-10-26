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
import { fixtureFiles } from "./script-fixture-files.test-support.js";

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
  const { file, write, json } = fixtureFiles(root);
  json("package.json", { type: "module" });
  write("pnpm-workspace.yaml", "packages: []\n");
  installDistArtifactScripts(root, ["run-tsgo-core-test-shards.mts", "run-tsgo.mts"], {
    compiler: false,
  });
  const events = file("compiler-events.jsonl");
  const compiler = write(
    "compiler.mjs",
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
    write("compiler.mjs.cmd", `@"${process.execPath}" "%~dp0compiler.mjs" %*\r\n`);
  }
  overrideNativeFixtureExecutable(root, compiler);
  return {
    override(source: string, replacement: string) {
      const target = write("override.mjs", replacement);
      return preparedScriptWrapperEnv([], ciEnv(), [
        [pathToFileURL(file(source)), pathToFileURL(target)],
      ]);
    },
    run: (args: string[], signal: AbortSignal, env = process.env) =>
      lifetime.track(
        runNodeScript(
          [path.join(root, "scripts/run-tsgo-core-test-shards.mts"), ...args],
          env,
          undefined,
          { cwd: root, signal, requireProcessTreeExit: true },
        ),
      ),
    events: () => readJsonLines<string>(events),
    commands: (name: string) => readJsonLines<string[]>(file(name)),
  };
}

const ciEnv = () => ({
  ...process.env,
  CI: "true",
  OPENCLAW_LOCAL_CHECK: "0",
  OPENCLAW_CI_STATIC_EVIDENCE: "1",
});

it.for([
  { name: "retry without evidence", ci: "true", expected: 4 },
  { name: "local fail-fast", ci: "", expected: 1 },
])("reports all root partition failures on $name", async ({ ci, expected }, { signal }) => {
  const f = fixture();
  const result = await f.run(["--ci-graphs-json", '["test-root"]'], signal, {
    ...ciEnv(),
    CI: ci,
    GITHUB_ACTIONS: "",
    GITHUB_RUN_ATTEMPT: "2",
    OPENCLAW_CI_STATIC_EVIDENCE: "0",
  });
  expect(result, result.stderr).toMatchObject({ error: undefined, status: 2 });
  expect(f.events()).toEqual(TSGO_ROOT_TEST_SHARDS.slice(0, expected).map((shard) => shard.config));
  expect(result.stdout).not.toContain("[ci-static:tsgo:completion]");
});

it.for([
  {
    name: "runs changed-path types after boundary validation fails",
    module: "scripts/check-tsgo-core-boundary.mts",
    source: `export class CoreTsgoBoundaryInterruptedError extends Error {}
export async function checkCoreTsgoGraphBoundary() { throw new Error("fixture boundary failure"); }
`,
    args: ["--changed-paths-json", '["src/fixture.test.ts"]', "--stripe", "1/5"],
    error: "fixture boundary failure",
  },
  {
    name: "keeps the watchdog stop when CI drains ordinary failures",
    module: "scripts/lib/managed-child-process.mts",
    source: `export * from ${JSON.stringify(new URL("../../scripts/lib/managed-child-process.mts", import.meta.url).href)};
import fs from "node:fs";
export async function runManagedCommand(command) {
  fs.appendFileSync("managed-calls.json", JSON.stringify(command.args) + "\\n");
  throw Object.assign(new Error("fixture watchdog expired"), { code: "ETIMEDOUT" });
}
`,
    args: ["--ci-graphs-json", '["test-root"]'],
    error: "killed the tsgo process tree",
  },
])("$name", async ({ module, source, args, error }, { signal }) => {
  const f = fixture();
  const result = await f.run(args, signal, f.override(module, source));
  expect(result).toMatchObject({ status: 1, stderr: expect.stringContaining(error) });
  if (module.endsWith("check-tsgo-core-boundary.mts")) {
    expect(result.stdout).toContain("error TS2322");
    expect(f.events().length).toBeGreaterThan(1);
  } else {
    const commands = f.commands("managed-calls.json");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(TSGO_ROOT_TEST_SHARDS[0].config);
    expect(result.stdout).not.toContain("[ci-static:tsgo:completion]");
  }
});
