import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../../../agents/agent-scope.js";
import { upsertAuthProfileAsync } from "../../../agents/auth-profiles/profiles.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { preserveImplicitOpenAIPrimary } from "./implicit-openai-primary.js";

type ProviderRow = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

function row(...ids: string[]): ProviderRow {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    models: ids.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    })),
  };
}

const LEGACY_META = { lastTouchedVersion: "2026.11.6" };
const OPENAI_KEY = { OPENAI_API_KEY: "sk-test" };

describe("preserveImplicitOpenAIPrimary", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function run(cfg: OpenClawConfig, credentials: Record<string, string> = {}) {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-implicit-primary-"), ...credentials };
    return preserveImplicitOpenAIPrimary(cfg, { env });
  }

  it.each<[string, OpenClawConfig, string]>([
    [
      "the OpenAI default with OpenAI credentials",
      { meta: LEGACY_META, agents: { defaults: { model: { fallbacks: ["other/backup"] } } } },
      "openai/gpt-6-astra",
    ],
    [
      "the OpenAI default OpenAI listed ahead of an earlier provider row",
      {
        meta: LEGACY_META,
        models: { providers: { local: row("small"), openai: row("gpt-6-astra") } },
      },
      "openai/gpt-6-astra",
    ],
    [
      "the OpenAI default when the only row is the separated utility model",
      {
        meta: { ...LEGACY_META, migrations: { utilityModelSeparation: true } },
        agents: { defaults: { utilityModel: "local/small" } },
        models: { providers: { local: row("small") } },
      },
      "openai/gpt-6-astra",
    ],
  ])("writes the model earlier releases ran: %s", async (_name, cfg, primary) => {
    const result = await run(cfg, OPENAI_KEY);
    expect(result.config.agents?.defaults?.model).toMatchObject({ primary });
    expect(result.changes).toHaveLength(1);
  });

  it("preserves the default when a later agent has its own OpenAI credentials", async () => {
    const stateDir = tempDirs.make("openclaw-implicit-primary-agents-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = { meta: LEGACY_META, agents: { entries: { a: {}, b: {} } } };
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await upsertAuthProfileAsync({
      profileId: "openai:b",
      credential: { type: "api_key", provider: "openai", key: "sk-test" },
      agentDir: resolveAgentDir(cfg, "b", env),
    });
    const result = await preserveImplicitOpenAIPrimary(cfg, { env });
    expect(result.config.agents?.defaults?.model).toMatchObject({ primary: "openai/gpt-6-astra" });
  });

  it.each<[string, OpenClawConfig, Record<string, string>]>([
    ["no OpenAI credentials", { meta: LEGACY_META }, {}],
    [
      "a config written by a newer release",
      { meta: { lastTouchedVersion: "2026.11.7" } },
      OPENAI_KEY,
    ],
    [
      "a configured primary",
      {
        meta: LEGACY_META,
        agents: { defaults: { model: { primary: "anthropic/claude-opus-5-5" } } },
      },
      OPENAI_KEY,
    ],
    [
      "a provider row runtime still selects",
      { meta: LEGACY_META, models: { providers: { local: row("local") } } },
      OPENAI_KEY,
    ],
  ])("leaves config unchanged with %s", async (_name, cfg, credentials) => {
    const result = await run(cfg, credentials);
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });
});
