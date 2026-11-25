import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suggestRecommendedModels } from "../../scripts/suggest-recommended-models.mts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const openRouterModel = (id: string, name: string, created: number) => ({
  id,
  name,
  canonical_slug: id,
  created,
  architecture: { output_modalities: ["text"] },
});
const arenaRow = (model_name: string, score: number, rank: number) => ({
  row: { model_name, score, rank, category: "overall", leaderboard_publish_date: "2026-10-01" },
});
const usageRow = (model_permaslug: string, total_tokens: number) => ({
  date: "2026-10-01",
  model_permaslug,
  total_tokens,
});

function stubSources(catalogModels: Array<{ id: string; provider: string }> = []) {
  const responses: Record<string, unknown> = {
    "datasets-server.huggingface.co": {
      num_rows_total: 3,
      rows: [
        arenaRow("glm-6", 1500, 1),
        arenaRow("kimi-k3", 1500, 1),
        arenaRow("gpt-5.4", 1600, 1),
      ],
    },
    "catalog.openclaw.ai": { generatedAt: Date.UTC(2026, 9, 1), models: catalogModels },
    "openrouter.ai/api/v1/models": {
      data: [
        openRouterModel("z-ai/glm-6", "Z.ai: GLM 6", 1_770_000_000),
        openRouterModel("moonshotai/kimi-k3", "MoonshotAI: Kimi K3", 1_770_000_000),
        openRouterModel("openai/gpt-5.4", "OpenAI: GPT-5.4", 1_770_000_000),
        openRouterModel("openai/gpt-5.5", "OpenAI: GPT-5.5", 1_775_000_000),
        openRouterModel("openai/gpt-5.6", "OpenAI: GPT-5.6", 1_780_000_000),
      ],
    },
    "openrouter.ai/api/v1/datasets/rankings-daily": {
      data: [
        usageRow("z-ai/glm-6", 20e9),
        usageRow("moonshotai/kimi-k3", 50e9),
        usageRow("openai/gpt-5.4", 100e9),
        usageRow("openai/gpt-5.5", 50e9),
        usageRow("openai/gpt-5.6", 10e9),
      ],
      meta: { as_of: "2026-10-01", start_date: "2026-09-01", end_date: "2026-09-30" },
    },
    "ai-gateway.vercel.sh": { data: [] },
  };
  vi.stubGlobal("fetch", async (url: string) => {
    const source = Object.keys(responses).find((prefix) => url.includes(prefix));
    return source
      ? new Response(JSON.stringify(responses[source]))
      : new Response("not found", { status: 404 });
  });
}

async function suggestedReport(curated = ["gpt-5.4", "gpt-5.6", "glm-6", "kimi-k3"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suggest-recommended-models-"));
  roots.push(root);
  const listPath = path.join(root, "list.json");
  fs.writeFileSync(listPath, `${JSON.stringify(curated)}\n`);
  let report = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    report += String(chunk);
    return true;
  });
  await suggestRecommendedModels(["--list", listPath]);
  return {
    order: [...report.matchAll(/^\| \d+ \| ([^ |]+) \|/gm)].map((match) => match[1]),
    report,
  };
}

describe("suggest-recommended-models ranking", () => {
  it("breaks equal Arena scores by usage and replaces the ranked predecessor", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    stubSources();

    // The middle generation has usage but no Arena score. The newest must
    // inherit the older Arena-ranked generation before both older rows leave.
    // kimi-k3 still outranks the equal-scored glm-6 on usage alone.
    const { order, report } = await suggestedReport();
    expect(order).toEqual(["gpt-5.6", "kimi-k3", "glm-6"]);
    expect(report).toContain("gpt-5.4: superseded by gpt-5.6");
  });

  it("replaces an unranked predecessor without dropping distinct tiers or same-model aliases", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    stubSources([
      { id: "claude-sonnet-5", provider: "anthropic" },
      { id: "claude-sonnet-5.5", provider: "anthropic" },
      { id: "claude-haiku-5", provider: "anthropic" },
      { id: "muse-wonder", provider: "openrouter" },
      { id: "muse-wonder-1", provider: "meta" },
    ]);

    const { order, report } = await suggestedReport([
      "claude-sonnet-5",
      "claude-haiku-5",
      "muse-wonder",
      "muse-wonder-1",
    ]);
    expect(order).toEqual([
      "gpt-5.6",
      "glm-6",
      "kimi-k3",
      "claude-sonnet-5.5",
      "claude-haiku-5",
      "muse-wonder",
      "muse-wonder-1",
    ]);
    expect(report).toContain("claude-sonnet-5: superseded by claude-sonnet-5.5");
  });
});
