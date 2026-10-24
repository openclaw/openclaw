import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createPreparedVitestCliFixture } from "./run-vitest-bounded-fixture.test-support.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const target = "test/scripts/empty-policy.synthetic.test.ts";
const sibling = "test/scripts/empty-policy-sibling.synthetic.test.ts";
const source = "test/scripts/empty-policy.synthetic.ts";
const isolated = "test/scripts/control-ui-i18n.test.ts";
const config = "test/vitest/vitest.tooling.config.ts";
const preparedCli = createPreparedVitestCliFixture(
  repoRoot,
  ["run-vitest.mts", "test-projects.mts"],
  { prepareWorkerArtifacts: true },
);
beforeAll(() => preparedCli.prepare());
afterAll(() => preparedCli.cleanup());

function emptyCase(
  name: string,
  code: number,
  flags: string[] = [],
  options: {
    entry?: string;
    excluded?: boolean;
    tests?: number;
    invalid?: boolean;
    help?: boolean;
    selectors?: string[];
    parallel?: boolean;
    emptyInvocations?: number;
    skipped?: boolean;
  } = {},
) {
  return { name, code, flags, ...options };
}
const runs = { excluded: false, tests: 1 };
const projects = { entry: "projects" };

it.for([
  emptyCase("delegated default", 1),
  emptyCase("package test entry default", 1, [], projects),
  emptyCase("projects compound help executes", 0, ["--help", "--no-help"], {
    ...projects,
    ...runs,
  }),
  emptyCase(
    "projects compound help validates",
    1,
    ["--help", "--no-help", "--passWithNoTests", "--passWithNoTests"],
    { ...projects, invalid: true },
  ),
  emptyCase(
    "projects compound help metadata",
    0,
    ["--no-help", "--help", "--unknown-router-option"],
    { ...projects, help: true },
  ),
  emptyCase("several exact files", 1, [], { selectors: [target, sibling] }),
  emptyCase("exact files across lanes", 1, [], {
    selectors: [target, isolated],
    parallel: true,
    emptyInvocations: 2,
  }),
  emptyCase("explicit true", 0, ["--passWithNoTests=true"]),
  emptyCase("bare opt-in", 0, ["--passWithNoTests"]),
  emptyCase(
    "separated exclusion matching routed target",
    0,
    ["--exclude", target, "--passWithNoTests"],
    { excluded: false },
  ),
  emptyCase("explicit false", 1, ["--passWithNoTests=false"]),
  emptyCase("native negation", 1, ["--no-passWithNoTests"]),
  emptyCase("native dashed spelling", 0, ["--pass-with-no-tests=true"]),
  emptyCase("invalid duplicate scalar", 1, ["--passWithNoTests", "--passWithNoTests"], {
    invalid: true,
  }),
  emptyCase("direct configured default", 1, ["--config", config]),
  emptyCase("cfg long control", 0, ["--config", config], runs),
  emptyCase("cfg short control", 0, ["-c", config], runs),
  emptyCase("cfg inline short", 0, [`-c=${config}`], runs),
  emptyCase("cfg inline strict", 1, [`-c=${config}`, "--passWithNoTests"]),
  ...[
    "--passWithNoTests=false",
    "--passWithNoTests=true",
    "--passWithNoTests",
    "--pass-with-no-tests=true",
  ].map((flag) => emptyCase(`direct configured strict ${flag}`, 1, ["--config", config, flag])),
  // Native parse errors before discovery remain infrastructure failures.
  emptyCase(
    "direct invalid scalar is not repaired",
    2,
    ["--config", config, "--no-passWithNoTests", "--passWithNoTests=true"],
    { invalid: true },
  ),
  emptyCase("delegated separated false", 1, ["--passWithNoTests", "false"]),
  emptyCase("delegated separated true", 0, ["--passWithNoTests", "true"]),
  emptyCase(
    "direct help with strict scalar",
    0,
    ["--config", config, "--passWithNoTests=false", "--help=true"],
    { help: true },
  ),
  emptyCase("disabled help executes", 0, ["--help", "false"], runs),
  emptyCase("named run version executes", 0, ["--version"], runs),
  emptyCase("directory selection", 0, [], { selectors: ["test/scripts"] }),
  emptyCase("glob selection", 0, [], { selectors: ["test/scripts/*.test.ts"] }),
  emptyCase("mixed basename and exact selection", 0, [], { selectors: ["empty-policy", target] }),
  emptyCase("config selection", 0, [], {
    ...projects,
    selectors: ["test/vitest/vitest.tooling-docker.config.ts"],
  }),
  emptyCase("source-derived selection", 0, [], { selectors: [source] }),
  emptyCase("native help", 0, ["--help=true"], { help: true }),
  emptyCase("non-excluded control", 0, [], runs),
  emptyCase("one surviving named file", 0, [], { selectors: [target, sibling], tests: 1 }),
  emptyCase("skipped case is still a discovered file", 0, [], { ...runs, skipped: true }),
])("$name", { timeout: 60_000 }, async (scenario, { signal, onTestFinished }) => {
  const lifetime = createFixtureLifetime();
  onTestFinished(() => lifetime.cleanup());
  await lifetime.run(async () => {
    // An unjoined child still owns its files: keep them outside the enclosing
    // Vitest process's disposable namespace, just like withShimFixture.
    const parent = process.platform === "win32" ? tmpdir() : path.dirname(tmpdir());
    const root = fs.realpathSync(lifetime.createTempDir("oc-default-empty-", parent));
    const at = (file: string) => path.join(root, file);
    const cli = (file: string) => path.join(preparedCli.root, "scripts", file);
    const stdout = createBoundedChildOutput();
    const stderr = createBoundedChildOutput();
    // Copy the real configs so their repoRoot is isolated; link their unchanged
    // setup, runner and source dependencies from the source checkout.
    fs.mkdirSync(at("test/scripts"), { recursive: true });
    for (const name of ["vitest", "tsconfig"]) {
      fs.cpSync(path.join(repoRoot, "test", name), at(`test/${name}`), {
        recursive: true,
      });
    }
    for (const name of ["scripts", "src", "packages", "ui", "node_modules"]) {
      fs.symlinkSync(path.join(repoRoot, name), at(name), "junction");
    }
    for (const name of ["package.json", "tsconfig.json"]) {
      fs.copyFileSync(path.join(repoRoot, name), at(name));
    }
    for (const entry of fs.readdirSync(path.join(repoRoot, "test"), { withFileTypes: true })) {
      if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
        fs.symlinkSync(path.join(repoRoot, "test", entry.name), at(`test/${entry.name}`), "file");
      }
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: at("home"),
      USERPROFILE: at("home"),
      OPENCLAW_HOME: at("home"),
      OPENCLAW_STATE_DIR: at("state"),
      OPENCLAW_CONFIG_PATH: at("state/openclaw.json"),
      TMPDIR: at("tmp"),
      TMP: at("tmp"),
      TEMP: at("tmp"),
      XDG_CACHE_HOME: at("cache"),
      XDG_CONFIG_HOME: at("config"),
      TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json"),
      TSX_DISABLE_CACHE: "1",
      NODE_COMPILE_CACHE: path.join(preparedCli.root, "node-compile-cache"),
      COREPACK_ENABLE_NETWORK: "0",
      GIT_OPTIONAL_LOCKS: "0",
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      OPENCLAW_TEST_PROJECTS_TIMINGS: "0",
      OPENCLAW_VITEST_MAX_WORKERS: "1",
      OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: at("module-cache"),
      ...(scenario.parallel ? { OPENCLAW_TEST_PROJECTS_PARALLEL: "2" } : {}),
    };
    for (const name of ["home", "state", "tmp", "cache", "config"]) {
      fs.mkdirSync(at(name));
    }
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, "{}");
    const runFixtureCommand = (bin: string, commandArgs: string[]) =>
      lifetime.track(
        runManagedCommand({
          bin,
          args: commandArgs,
          cwd: root,
          env: preparedCli.env(env),
          signal,
          stdio: ["ignore", "pipe", "pipe"],
          timeoutMs: 45_000,
          timeoutKillGraceMs: 10_000,
          requireProcessTreeExit: process.platform !== "win32",
          onReady(child) {
            child.stdout?.on("data", stdout.append);
            child.stderr?.on("data", stderr.append);
          },
        }),
      );
    // Discovery must not inherit an enclosing checkout's ignored temp directory.
    expect(await runFixtureCommand("git", ["init", "--quiet"]), stderr.text()).toBe(0);
    const marker = at("executed");
    fs.writeFileSync(at(source), "export const value = 1;\n");
    for (const file of [target, sibling, ...(scenario.parallel ? [isolated] : [])]) {
      fs.writeFileSync(
        at(file),
        `import fs from "node:fs";
import { it } from "vitest";
import "./empty-policy.synthetic.ts";
it${scenario.skipped ? ".skip" : ""}("records execution", () => fs.appendFileSync(${JSON.stringify(marker)}, "executed\\n"));
`,
      );
    }
    const output = at("native.json");
    const args = [
      ...(scenario.entry === "projects"
        ? ["--import", cli("tsx.mjs"), cli("test-projects.mts")]
        : [cli("run-vitest.mjs")]),
      ...(scenario.selectors ?? [target]),
      ...(scenario.emptyInvocations
        ? ["--reporter=verbose"]
        : ["--reporter=json", `--outputFile=${output}`]),
      "--exclude=src/scripts/**",
      ...(scenario.excluded === false
        ? []
        : [
            `--exclude=${target}`,
            ...(scenario.tests ? [] : [`--exclude=${sibling}`]),
            ...(scenario.parallel ? [`--exclude=${isolated}`] : []),
          ]),
      ...(scenario.flags ?? []),
    ];
    const code = await runFixtureCommand(process.execPath, args);
    const report = fs.existsSync(output)
      ? (JSON.parse(fs.readFileSync(output, "utf8")) as JsonTestResults)
      : undefined;
    const [out, err] = [stdout.text(), stderr.text()];
    const evidence = JSON.stringify({ args, code, stdout: out, stderr: err, report });
    expect(code, evidence).toBe(scenario.code);
    expect(err, evidence).not.toContain("Unhandled Errors");
    if (scenario.emptyInvocations) {
      expect(err.match(/No test files found, exiting with code 1/gu), evidence).toHaveLength(
        scenario.emptyInvocations,
      );
    } else if (scenario.help) {
      expect(out.match(/Usage:/gu), evidence).toHaveLength(1);
      expect(out, evidence).toMatch(/^vitest\//mu);
      expect(report).toBeUndefined();
    } else if (scenario.invalid) {
      expect(err).toContain("Expected a single value for option");
      expect(report).toBeUndefined();
    } else {
      expect(report, evidence).toMatchObject({
        success: scenario.code === 0,
        numTotalTests: scenario.tests ?? 0,
      });
      expect(report?.testResults).toHaveLength(scenario.tests ? 1 : 0);
    }
    expect(fs.existsSync(marker), evidence).toBe(Boolean(scenario.tests && !scenario.skipped));
  });
});
