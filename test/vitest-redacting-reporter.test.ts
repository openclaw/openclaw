import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { testRunnerFixtureEnv } from "./scripts/prepared-script-wrapper.test-support.js";
import { createPreparedVitestCliFixture } from "./scripts/run-vitest-bounded-fixture.test-support.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const synthetic = "not-a-real-secret-value-1234567890";
const preparedCli = createPreparedVitestCliFixture(repoRoot, ["run-vitest.mts"]);
beforeAll(() => preparedCli.prepare());
afterAll(() => preparedCli.cleanup());

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("retains the active fork case location without publishing its title", () => {
  const root = tempDirs.make("oc-reporter-progress-");
  const diagnostics = path.join(root, "diagnostics");
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"), "junction");
  const config = path.join(root, "vitest.config.mts");
  fs.writeFileSync(
    config,
    `import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default {
  ...sharedVitestConfig, root: ${JSON.stringify(root)},
  test: {
    ...sharedVitestConfig.test, root: ${JSON.stringify(root)}, dir: ${JSON.stringify(root)},
    include: ["synthetic.test.ts"], exclude: [], setupFiles: [], runner: undefined,
    pool: "forks", isolate: true, includeTaskLocation: true, maxWorkers: 1,
    reporters: ["default", ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-resource-reporter.mts"))}],
  },
};`,
  );
  fs.writeFileSync(
    path.join(root, "synthetic.test.ts"),
    `import fs from "node:fs";
import path from "node:path";
import { it, expect } from "vitest";
it(${JSON.stringify(synthetic)}, async () => {
  const directory = ${JSON.stringify(diagnostics)};
  const read = () => fs.readFileSync(path.join(directory, fs.readdirSync(directory)[0], "failure.public.json"), "utf8");
  await expect.poll(() => JSON.parse(read()).active[0]?.cases.length).toBe(1);
  const report = read();
  const { active } = JSON.parse(report);
  expect(active).toHaveLength(1);
  expect(active[0]).toMatchObject({ file: "synthetic.test.ts", pool: "forks", phase: "running" });
  expect(active[0].cases).toEqual([{ id: expect.any(String), location: { line: 4, column: 1 } }]);
  expect(report).not.toContain(${JSON.stringify(synthetic)});
});`,
  );
  const child = spawnSync(
    resolveTestNodeExecPath(),
    [path.join(preparedCli.root, "scripts/run-vitest.mjs"), "run", "--config", config],
    {
      cwd: repoRoot,
      env: preparedCli.env({
        ...testRunnerFixtureEnv(),
        OPENCLAW_VITEST_RUNTIME: "node",
        OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: diagnostics,
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "module-cache"),
      }),
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child, child.stdout + child.stderr).toMatchObject({ signal: null, status: 0 });
  const finalReport = JSON.parse(
    fs.readFileSync(
      path.join(diagnostics, fs.readdirSync(diagnostics)[0]!, "failure.public.json"),
      "utf8",
    ),
  );
  expect(finalReport).toMatchObject({ active: [], reason: "passed" });
});

it.each([
  ["deep-equality", "EXAMPLE_TOKEN", synthetic],
  ["spy-call", "EXAMPLE_TOKEN", synthetic],
  ["node-multiline", "PRIVATE_KEY", [synthetic, synthetic, synthetic].join("\n")],
  ["entries-array", "EXAMPLE_TOKEN", synthetic],
  ["resolved-env", "FAL_KEY", synthetic],
  ["exact-value", "EXAMPLE_TOKEN", synthetic],
])("redacts %s failures through the shard runner", (kind, credential, value) => {
  const marker = `<redacted len=${value.length}>`;
  const root = tempDirs.make("oc-reporter-redaction-");
  const file = (name: string) => path.join(root, name);
  fs.symlinkSync(path.join(repoRoot, "node_modules"), file("node_modules"), "junction");
  const config = file("vitest.config.mts");
  fs.writeFileSync(
    config,
    `
import { sharedVitestConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))};
export default {
  ...sharedVitestConfig,
  root: ${JSON.stringify(root)},
  cacheDir: ${JSON.stringify(path.join(root, "vite-cache"))},
  test: {
    ...sharedVitestConfig.test,
    root: ${JSON.stringify(root)}, dir: ${JSON.stringify(root)},
    include: ["synthetic.test.ts"], exclude: [], setupFiles: [], runner: undefined,
    maxWorkers: 1, fileParallelism: false,
    reporters: ["verbose", ["json", { outputFile: ${JSON.stringify(path.join(root, "result.json"))} }], ["junit", { outputFile: ${JSON.stringify(path.join(root, "result.xml"))} }]],
  },
};
`,
  );
  fs.writeFileSync(
    path.join(root, "synthetic.test.ts"),
    `
import assert from "node:assert/strict";
import { chai, expect, it, vi } from "vitest";
chai.config.truncateThreshold = 0;
it("synthetic ${kind} failure", async ({ annotate }) => {
  await annotate(${JSON.stringify(`AUTHORIZATION=Bearer ${synthetic}\nretained % detail`)}, ${JSON.stringify(`EXAMPLE_TOKEN=${synthetic}`)});
  const actual = ${kind === "resolved-env" ? `{ databaseTarget: { env: { FAL_KEY: ${JSON.stringify(value)}, NORMAL: "x" } } }` : kind === "exact-value" ? `{ url: "https://example.invalid/?q=" + process.env.EXAMPLE_PROVIDER_KEY }` : kind === "entries-array" ? `Object.entries({ ${credential}: ${JSON.stringify(value)}, NORMAL: "received" })` : `{ nested: { env: { ${credential}: ${JSON.stringify(value)} } }, visible: "received" }`};
  const expected = ${kind === "entries-array" ? `Object.entries({ ${credential}: ${JSON.stringify(value)}, NORMAL: "expected" })` : `{ nested: { env: { ${kind === "node-multiline" ? "" : `${credential}: ${JSON.stringify(value)}`} } }, visible: "expected" }`};
  ${kind === "resolved-env" ? "await expect(Promise.resolve(actual)).rejects.toThrow();" : kind === "node-multiline" ? "assert.deepStrictEqual(actual, expected);" : kind === "spy-call" ? "const spy = vi.fn(); spy(actual); expect(spy).toHaveBeenCalledWith(expected);" : "expect(actual).toEqual(expected);"}
});
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(testRunnerFixtureEnv()).filter(([key]) => !/^(VITEST|OPENCLAW_)/u.test(key)),
    ),
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_VITEST_RUNTIME: "node",
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "module-cache"),
    GITHUB_ACTIONS: "true",
    GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    ...(kind === "exact-value" ? { EXAMPLE_PROVIDER_KEY: synthetic } : {}),
  };
  const child = spawnSync(
    resolveTestNodeExecPath(),
    [
      path.join(preparedCli.root, "scripts/run-vitest.mjs"),
      "run",
      "--config",
      config,
      ...`verbose default dot github-actions json junit ./scripts/lib/vitest-resource-reporter.mts`
        .split(" ")
        .map((reporter) => `--reporter=${reporter}`),
    ],
    {
      cwd: repoRoot,
      env: preparedCli.env(env),
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child).toMatchObject({ signal: null, status: 1 });
  const output = child.stdout + child.stderr;
  expect(output.includes(marker), output.replaceAll(synthetic, "[synthetic value]")).toBe(true);
  expect(output.includes(synthetic), output.replaceAll(synthetic, "[synthetic value]")).toBe(false);
  expect(output).toContain(`synthetic ${kind} failure`);
  expect(output).toContain("::error ");
  const notice = output.split("\n").find((line) => line.startsWith("::notice "));
  expect(notice).toContain(
    "title=EXAMPLE_TOKEN=<redacted len=34>::AUTHORIZATION=<redacted len=41>%0Aretained %25 detail",
  );
  expect(output).toContain(kind === "exact-value" ? "https://example.invalid/?q=" : credential);
  expect(output).toContain("[vitest:resources]");
  for (const outputFile of ["result.json", "result.xml", "summary.md"]) {
    const report = fs.readFileSync(file(outputFile), "utf8");
    expect(report.includes(synthetic), outputFile).toBe(false);
    if (outputFile !== "summary.md") {
      expect(report, outputFile).toContain(`redacted len=${value.length}`);
    }
  }
});
