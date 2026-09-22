import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    suiteId: string;
  },
) {
  const root = command.createTempDir("openclaw-frozen-codex-");
  if (params.catalog !== false) {
    const catalogDir = join(root, "extensions/codex");
    mkdirSync(catalogDir, { recursive: true });
    const models = (params.modelIds ?? ["gpt-5.5"])
      .map((id) => `  { id: "${id}", model: "${id}" },`)
      .join("\n");
    writeFileSync(
      join(catalogDir, "provider-catalog.ts"),
      `export const FALLBACK_CODEX_MODELS = [\n${models}\n] satisfies unknown[];\n`,
    );
  }
  if (params.harnessModel) {
    const scriptsDir = join(root, "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(
      join(scriptsDir, "test-live-codex-harness-docker.sh"),
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
        OPENCLAW_FROZEN_CODEX_SUITE_ID: params.suiteId,
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

describe("frozen Codex live-suite resolver", () => {
  it("selects the newest model exposed by an older frozen target", async ({ command }) => {
    const result = await runResolver(command, { suiteId: "live-codex-harness-docker" });

    expect(result.status).toBe(0);
    expect(result.output).toBe("run_lane=true\n");
    expect(result.envFile).toBe("OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/gpt-5.5\n");
    expect(result.summary).toContain("uses `openai/gpt-5.5`");
  });

  it("omits GPT-5.6-only lanes from targets that predate the capability cohort", async ({
    command,
  }) => {
    const result = await runResolver(command, { suiteId: "live-codex-harness-gpt56-sol-docker" });

    expect(result.status).toBe(0);
    expect(result.output).toBe("run_lane=false\n");
    expect(result.envFile).toBe("");
    expect(result.summary).toContain("omitted unsupported current-only suite");
  });

  it("keeps the current GPT-5.6 cohort and generic default unchanged", async ({ command }) => {
    const modelIds = ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"];
    const dedicated = await runResolver(command, {
      modelIds,
      suiteId: "live-codex-harness-gpt56-terra-docker",
    });
    const generic = await runResolver(command, { modelIds, suiteId: "live-codex-harness-docker" });

    expect(dedicated.status).toBe(0);
    expect(dedicated.output).toBe("run_lane=true\n");
    expect(generic.status).toBe(0);
    expect(generic.envFile).toBe("OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/gpt-5.6-luna\n");
  });

  it("uses the frozen harness contract after the target catalog was removed", async ({
    command,
  }) => {
    const result = await runResolver(command, {
      catalog: false,
      harnessModel: "openai/gpt-5.6-luna",
      suiteId: "live-codex-harness-docker",
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe("run_lane=true\n");
    expect(result.envFile).toBe("OPENCLAW_LIVE_CODEX_HARNESS_MODEL=openai/gpt-5.6-luna\n");
  });

  it("does not infer specialized GPT-5.6 support from a catalog-free harness default", async ({
    command,
  }) => {
    const result = await runResolver(command, {
      catalog: false,
      harnessModel: "openai/gpt-5.6-luna",
      suiteId: "live-codex-harness-gpt56-sol-docker",
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe("run_lane=false\n");
    expect(result.envFile).toBe("");
    expect(result.summary).toContain("omitted unsupported current-only suite");
  });

  it("omits GPT-5.6 suites for a catalog-free target with the older harness default", async ({
    command,
  }) => {
    const result = await runResolver(command, {
      catalog: false,
      harnessModel: "codex/gpt-5.5",
      suiteId: "live-codex-harness-gpt56-sol-docker",
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe("run_lane=false\n");
    expect(result.envFile).toBe("");
    expect(result.summary).toContain("omitted unsupported current-only suite");
  });

  it("does nothing without the trusted frozen-target opt-in", async ({ command }) => {
    const result = await runResolver(command, {
      allow: false,
      suiteId: "live-codex-harness-gpt56-sol-docker",
    });

    expect(result.status).toBe(0);
    expect(result.output).toBe("run_lane=true\n");
    expect(result.summary).toBe("");
  });

  it("fails closed on an incomplete GPT-5.6 capability marker", async ({ command }) => {
    const result = await runResolver(command, {
      modelIds: ["gpt-5.6-sol", "gpt-5.5"],
      suiteId: "live-codex-harness-docker",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("capability marker is incomplete");
    expect(result.output).toBe("");
  });
});
