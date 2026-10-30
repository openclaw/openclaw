import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { afterEach, expect, it } from "vitest";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("resolves private QA delivery helpers from bundled flow expressions", async () => {
  const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
  const selected = configs.find((config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP);
  expect(selected).toBeDefined();
  const root = fs.realpathSync(tempDirs.make("openclaw-qa-flow-bundle-"));
  fs.copyFileSync("package.json", path.join(root, "package.json"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  const { bundles } = await build({
    ...selected,
    config: false,
    entry: { "qa-flow": "extensions/qa-lab/src/scenario-flow-runner.ts" },
    outDir: path.join(root, "dist"),
    dts: false,
    logLevel: "silent",
  });
  try {
    const script = `
      import assert from "node:assert/strict";
      import { runScenarioFlow } from "./dist/qa-flow.js";
      await assert.rejects(import("openclaw/plugin-sdk/qa-runtime"), {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      });
      const vars = {
        finalText: "A QA lighthouse.\\n\\n![Lighthouse](/generated.png)",
        generatedPath: "/generated.png",
      };
      await runScenarioFlow({
        scenarioTitle: "bundled image delivery",
        vars,
        api: {
          state: {}, scenario: { id: "bundled-image-delivery" }, config: {},
          runScenario: async (name, steps) => {
            for (const step of steps) await step.run();
            return { name, status: "pass", steps: [] };
          },
        },
        flow: { steps: [{ name: "normalize delivery", actions: [{
          set: "payloads",
          value: { expr: "(await qaImport('openclaw/plugin-sdk/qa-runtime')).mergeAttemptToolMediaPayloads({ payloads: [{ text: finalText }], toolMediaUrls: [generatedPath] })" },
        }] }] },
      });
      assert.equal(vars.payloads.length, 1);
      assert.equal(vars.payloads[0].text, "A QA lighthouse.");
      assert.deepEqual(vars.payloads[0].mediaUrls, ["/generated.png"]);
    `;
    const result = await new Promise<{ error: Error | null; stderr: string }>((resolve) => {
      execFile(
        resolveTestNodeExecPath(),
        ["--input-type=module", "--eval", script],
        { cwd: root, timeout: 30_000 },
        (error, _stdout, stderr) => resolve({ error, stderr }),
      );
    });
    expect(result.error, result.stderr).toBeNull();
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
