import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect } from "vitest";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const it = createCommandTest();

async function runResolver(
  command: CommandFixture,
  params: {
    allow?: boolean;
    catalog?: boolean;
    harnessModel?: string;
    modelIds?: string[];
    selectedSha?: string;
    suiteId?: string;
  },
) {
  const root = command.createTempDir("openclaw-frozen-codex-");
  const write = (file: string, source: string) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  if (params.catalog !== false) {
    const models = (params.modelIds ?? ["gpt-5.5"])
      .map((id) => `  { id: "${id}", model: "${id}" },`)
      .join("\n");
    write(
      "extensions/codex/provider-catalog.ts",
      `export const FALLBACK_CODEX_MODELS = [\n${models}\n] satisfies unknown[];\n`,
    );
  }
  if (params.harnessModel) {
    write(
      "scripts/test-live-codex-harness-docker.sh",
      `model="\${OPENCLAW_LIVE_CODEX_HARNESS_MODEL:-${params.harnessModel}}"\n`,
    );
  }
  const output = join(root, "output");
  const envFile = join(root, "env");
  const summary = join(root, "summary");
  for (const file of [output, envFile, summary]) {
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
        OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: params.allow === false ? "0" : "1",
        OPENCLAW_FROZEN_CODEX_SUITE_ID: params.suiteId ?? "live-codex-harness-docker",
        OPENCLAW_FROZEN_TARGET_ROOT: root,
        OPENCLAW_SELECTED_SHA: params.selectedSha ?? "a".repeat(40),
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

function expectLane(result: Awaited<ReturnType<typeof runResolver>>, model?: string, run = true) {
  expect(result).toMatchObject({
    status: 0,
    output: `run_lane=${run}\n`,
    envFile: model ? `OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/${model}\n` : "",
  });
}

describe("frozen Codex live-suite resolver", () => {
  it.for<{
    name: string;
    params: Parameters<typeof runResolver>[1];
    model?: string;
    run?: boolean;
    summary: string | null;
  }>([
    { name: "older catalog", params: {}, model: "gpt-5.5", summary: "uses `openai/gpt-5.5`" },
    {
      name: "catalog-free harness",
      params: { catalog: false, harnessModel: "openai/gpt-5.6-luna" },
      model: "gpt-5.6-luna",
      summary: "",
    },
    {
      name: "unsupported specialized harness",
      params: {
        catalog: false,
        harnessModel: "openai/gpt-5.6-luna",
        suiteId: "live-codex-harness-gpt56-sol-docker",
      },
      run: false,
      summary: "omitted unsupported current-only suite",
    },
    {
      name: "no trusted opt-in",
      params: { allow: false, suiteId: "live-codex-harness-gpt56-sol-docker" },
      summary: null,
    },
  ])("resolves $name", async ({ params, model, run, summary }, { command }) => {
    const result = await runResolver(command, params);
    expectLane(result, model, run);
    if (summary === null) {
      expect(result.summary).toBe("");
    } else if (summary) {
      expect(result.summary).toContain(summary);
    }
  });
  it("keeps the current GPT-5.6 cohort and generic default unchanged", async ({ command }) => {
    const modelIds = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"];
    const dedicated = await runResolver(command, {
      modelIds,
      suiteId: "live-codex-harness-gpt56-terra-docker",
    });
    const generic = await runResolver(command, { modelIds });

    expectLane(dedicated);
    expectLane(generic, "gpt-5.6-luna");
  });

  it("fails closed on an incomplete GPT-5.6 capability marker", async ({ command }) => {
    const result = await runResolver(command, {
      modelIds: ["gpt-5.6-sol", "gpt-5.5"],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("capability marker is incomplete");
    expect(result.output).toBe("");
  });
});
