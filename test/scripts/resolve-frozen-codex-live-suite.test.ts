import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const it = createCommandTest();
const cohort = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"];
type Target = { models?: string[]; harness?: boolean; suite?: string; allow?: boolean };

async function runResolver(command: CommandFixture, target: Target) {
  const root = command.createTempDir("openclaw-frozen-codex-");
  const write = (file: string, source: string) => {
    const destination = join(root, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  };
  if (target.harness) {
    write(
      "scripts/test-live-codex-harness-docker.sh",
      'model="${OPENCLAW_LIVE_CODEX_HARNESS_MODEL:-openai/gpt-5.6-luna}"\n',
    );
  } else {
    const models = (target.models ?? ["gpt-5.5"]).map((id) => `{ id: "${id}" }`).join(", ");
    write(
      "extensions/codex/provider-catalog.ts",
      `export const FALLBACK_CODEX_MODELS = [${models}] satisfies unknown[];\n`,
    );
  }
  const envFile = join(root, "env"),
    output = join(root, "output"),
    summary = join(root, "summary");
  for (const file of [envFile, output, summary]) {
    writeFileSync(file, "");
  }
  const result = await command.run(
    process.execPath,
    ["scripts/resolve-frozen-codex-live-suite.mjs"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ENV: envFile,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: target.allow === false ? "0" : "1",
        OPENCLAW_FROZEN_CODEX_SUITE_ID: `live-codex-harness${target.suite ? `-gpt56-${target.suite}` : ""}-docker`,
        OPENCLAW_FROZEN_TARGET_ROOT: root,
        OPENCLAW_SELECTED_SHA: "a".repeat(40),
        OPENCLAW_WORKFLOW_SHA: "b".repeat(40),
      },
    },
  );
  expect(result.error, "frozen live-suite resolver subprocess").toBeUndefined();
  return {
    ...result,
    envFile: readFileSync(envFile, "utf8"),
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

type Lane = [name: string, target: Target, model: string | null, run: boolean];
it.for<Lane>([
  ["older catalog", {}, "gpt-5.5", true],
  ["current generic default", { models: cohort }, "gpt-5.6-luna", true],
  ["current dedicated cohort", { models: cohort, suite: "terra" }, null, true],
  ["catalog-free harness", { harness: true }, "gpt-5.6-luna", true],
  ["unsupported specialized harness", { harness: true, suite: "sol" }, null, false],
  ["no trusted opt-in", { allow: false, suite: "sol" }, null, true],
])("frozen Codex resolver: %s", async ([, target, model, run], { command }) => {
  const result = await runResolver(command, target);
  expect(result).toMatchObject({
    status: 0,
    output: `run_lane=${run}\n`,
    envFile: model ? `OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/${model}\n` : "",
  });
  if (target.allow === false) {
    expect(result.summary).toBe("");
  }
  if (!run) {
    expect(result.summary).toContain("omitted unsupported current-only suite");
  }
  if (!target.models && !target.harness && model) {
    expect(result.summary).toContain(`uses \`openai/${model}\``);
  }
});

it("fails closed on an incomplete GPT-5.6 capability marker", async ({ command }) => {
  const result = await runResolver(command, { models: ["gpt-5.6-sol", "gpt-5.5"] });
  expect(result).toMatchObject({
    status: 1,
    output: "",
    stderr: expect.stringContaining("capability marker is incomplete"),
  });
});
