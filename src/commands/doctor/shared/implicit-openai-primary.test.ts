import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { preserveImplicitOpenAIPrimary } from "./implicit-openai-primary.js";

describe("preserveImplicitOpenAIPrimary", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function run(cfg: OpenClawConfig, credentials: Record<string, string> = {}) {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-implicit-primary-"), ...credentials };
    return preserveImplicitOpenAIPrimary(cfg, { env });
  }

  it("writes the model earlier releases ran when OpenAI credentials are available", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { fallbacks: ["other/backup"] } } },
    };
    const result = await run(cfg, { OPENAI_API_KEY: "sk-test" });
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-6-astra",
      fallbacks: ["other/backup"],
    });
    expect(result.changes).toHaveLength(1);
  });

  it.each<[string, OpenClawConfig, Record<string, string>]>([
    ["no OpenAI credentials", {}, {}],
    [
      "a configured primary",
      { agents: { defaults: { model: { primary: "anthropic/claude-opus-5-5" } } } },
      { OPENAI_API_KEY: "sk-test" },
    ],
    [
      "a configured provider row",
      {
        models: {
          providers: {
            local: {
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "local",
                  name: "Local",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 4_096,
                },
              ],
            },
          },
        },
      },
      { OPENAI_API_KEY: "sk-test" },
    ],
  ])("leaves config unchanged with %s", async (_name, cfg, credentials) => {
    const result = await run(cfg, credentials);
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
  });
});
