import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { createPreparedVitestCliFixture } from "./scripts/run-vitest-bounded-fixture.test-support.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const synthetic = "not-a-real-secret-value-1234567890";
const preparedCli = createPreparedVitestCliFixture(repoRoot, ["run-vitest.mts"]);
beforeAll(() => preparedCli.prepare());
afterAll(() => preparedCli.cleanup());

describe("Vitest public reporter output", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each(["deep-equality", "spy-call", "node-multiline", "entries-array"])(
    "redacts %s failures through the shard runner",
    (kind) => {
      const credential = kind === "node-multiline" ? "PRIVATE_KEY" : "EXAMPLE_TOKEN";
      const value =
        kind === "node-multiline" ? [synthetic, synthetic, synthetic].join("\n") : synthetic;
      const marker = `<redacted len=${value.length}>`;
      const root = tempDirs.make("oc-reporter-redaction-");
      fs.symlinkSync(
        path.join(repoRoot, "node_modules"),
        path.join(root, "node_modules"),
        "junction",
      );
      const config = path.join(root, "vitest.config.mts");
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
  const actual = ${kind === "entries-array" ? `Object.entries({ ${credential}: ${JSON.stringify(value)}, NORMAL: "received" })` : `{ nested: { env: { ${credential}: ${JSON.stringify(value)} } }, visible: "received" }`};
  const expected = ${kind === "entries-array" ? `Object.entries({ ${credential}: ${JSON.stringify(value)}, NORMAL: "expected" })` : `{ nested: { env: { ${kind === "node-multiline" ? "" : `${credential}: ${JSON.stringify(value)}`} } }, visible: "expected" }`};
  ${kind === "node-multiline" ? "assert.deepStrictEqual(actual, expected);" : kind === "spy-call" ? "const spy = vi.fn(); spy(actual); expect(spy).toHaveBeenCalledWith(expected);" : "expect(actual).toEqual(expected);"}
});
`,
      );
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_")) {
          delete env[key];
        }
      }
      Object.assign(env, {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(root, "module-cache"),
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: path.join(root, "summary.md"),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      });
      const child = spawnSync(
        resolveTestNodeExecPath(),
        [
          path.join(preparedCli.root, "scripts/run-vitest.mjs"),
          "run",
          "--config",
          config,
          "--reporter=verbose",
          "--reporter=default",
          "--reporter=dot",
          "--reporter=github-actions",
          "--reporter=json",
          "--reporter=junit",
          "--reporter=./scripts/lib/vitest-resource-reporter.mts",
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
      expect(child.signal).toBeNull();
      expect(child.status).toBe(1);
      const output = child.stdout + child.stderr;
      expect(output.includes(marker), output.replaceAll(synthetic, "[synthetic value]")).toBe(true);
      expect(output.includes(synthetic), output.replaceAll(synthetic, "[synthetic value]")).toBe(
        false,
      );
      expect(output).toContain(`synthetic ${kind} failure`);
      expect(output).toContain("::error ");
      const notice = output.split("\n").find((line) => line.startsWith("::notice "));
      expect(notice).toContain(
        "title=EXAMPLE_TOKEN=<redacted len=34>::AUTHORIZATION=<redacted len=41>%0Aretained %25 detail",
      );
      expect(output).toContain(credential);
      expect(output).toContain("[vitest:resources]");
      for (const file of ["result.json", "result.xml"]) {
        const report = fs.readFileSync(path.join(root, file), "utf8");
        expect(report.includes(synthetic), file).toBe(false);
        expect(report, file).toContain(`redacted len=${value.length}`);
      }
    },
  );
});
