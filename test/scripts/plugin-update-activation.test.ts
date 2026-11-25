import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { settlePluginUpdate } from "../../scripts/e2e/lib/plugin-update/activation.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temps = useAutoCleanupTempDirTracker(afterEach);

it("waits for the requested run's plugin step, not an unrelated completed run", async () => {
  const root = temps.make("plugin-activation-");
  const entry = join(root, "cli.mjs");
  const output = join(root, "run.json");
  writeFileSync(
    entry,

    'import { existsSync, writeFileSync } from "node:fs";\n' +
      'const count = new URL("./polled", import.meta.url);\n' +
      'const pluginStep = { step: "plugins", status: "completed" };\n' +
      'const run = { runId: "selected", phase: "finished", status: "succeeded", ' +
      'after: { version: "2100.1.0" }, steps: existsSync(count) ? [pluginStep] : [] };\n' +
      'writeFileSync(count, "");\n' +
      'console.log(JSON.stringify({ activeRun: run, lastRun: { ...run, runId: "other", steps: [pluginStep] } }));\n',
  );
  const result = await settlePluginUpdate(
    entry,
    { runId: "selected", target: { version: "2100.1.0" }, status: "succeeded" },
    "2100.1.0",
    output,
  );
  expect(result.receipt.runId).toBe("selected");
  expect(result.pluginStep.status).toBe("completed");
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result.receipt);
});
