import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { logWarn } from "../logger.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import type { CronJob } from "./types.js";

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logWarn: vi.fn(),
  };
});

const withTempHome = withTempCronHome;

/**
 * Extract the provider and model from the last runEmbeddedPiAgent call.
 */
function lastEmbeddedCall(): { provider?: string; model?: string } {
  const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls.at(-1)?.[0] as { provider?: string; model?: string };
}

async function runCronWithModel(
  home: string,
  payloadModel: string,
  cfgOverrides?: Partial<Parameters<typeof makeCfg>[2]>,
) {
  const storePath = await writeSessionStoreEntries(home, {
    "agent:main:main": {
      sessionId: "main-session",
      updatedAt: Date.now(),
      lastProvider: "webchat",
      lastTo: "",
    },
  });
  mockAgentPayloads([{ text: "ok" }]);

  const jobPayload: CronJob["payload"] = {
    kind: "agentTurn",
    message: "test message",
    model: payloadModel,
    deliver: false,
  };

  const res = await runCronIsolatedAgentTurn({
    cfg: makeCfg(home, storePath, cfgOverrides),
    deps: createCliDeps(),
    job: makeJob(jobPayload),
    message: "test message",
    sessionKey: "cron:job-1",
    lane: "cron",
  });

  return { res, call: lastEmbeddedCall() };
}

describe("runCronIsolatedAgentTurn: payload.model override (#47592)", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
    vi.mocked(logWarn).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  describe("OpenRouter nested provider paths", () => {
    it("forwards openrouter/anthropic/claude-haiku-4-5 correctly", async () => {
      await withTempHome(async (home) => {
        const { res, call } = await runCronWithModel(
          home,
          "openrouter/anthropic/claude-haiku-4-5",
        );
        expect(res.status).toBe("ok");
        expect(call.provider).toBe("openrouter");
        expect(call.model).toBe("anthropic/claude-haiku-4-5");
        expect(vi.mocked(logWarn)).not.toHaveBeenCalled();
      });
    });

    it("forwards openrouter/anthropic/claude-3-5-haiku-latest correctly", async () => {
      await withTempHome(async (home) => {
        const { res, call } = await runCronWithModel(
          home,
          "openrouter/anthropic/claude-3-5-haiku-latest",
        );
        expect(res.status).toBe("ok");
        expect(call.provider).toBe("openrouter");
        expect(call.model).toBe("anthropic/claude-3-5-haiku-latest");
      });
    });

    it("forwards openrouter/meta-llama/llama-3.3-70b:free correctly", async () => {
      await withTempHome(async (home) => {
        const { res, call } = await runCronWithModel(
          home,
          "openrouter/meta-llama/llama-3.3-70b:free",
        );
        expect(res.status).toBe("ok");
        expect(call.provider).toBe("openrouter");
        expect(call.model).toBe("meta-llama/llama-3.3-70b:free");
      });
    });
  });

  describe("model override with explicit allowlist", () => {
    it("allows payload model when in allowlist", async () => {
      await withTempHome(async (home) => {
        const { res, call } = await runCronWithModel(
          home,
          "openai/gpt-4.1-mini",
          {
            agents: {
              defaults: {
                model: "anthropic/claude-opus-4-5",
                models: {
                  "openai/gpt-4.1-mini": {},
                },
              },
            },
          },
        );
        expect(res.status).toBe("ok");
        expect(call.provider).toBe("openai");
        expect(call.model).toBe("gpt-4.1-mini");
        expect(vi.mocked(logWarn)).not.toHaveBeenCalled();
      });
    });

    it("logs warning and falls back when payload model is not in allowlist", async () => {
      await withTempHome(async (home) => {
        const { res, call } = await runCronWithModel(
          home,
          "openrouter/anthropic/claude-haiku-4-5",
          {
            agents: {
              defaults: {
                model: "anthropic/claude-opus-4-5",
                models: {
                  "anthropic/claude-opus-4-5": {},
                  // openrouter model NOT in allowlist
                },
              },
            },
          },
        );
        expect(res.status).toBe("ok");
        // Should fall back to default model
        expect(call.provider).toBe("anthropic");
        expect(call.model).toBe("claude-opus-4-5");
        // Should have logged a warning
        expect(vi.mocked(logWarn)).toHaveBeenCalledWith(
          expect.stringContaining("not allowed"),
        );
      });
    });
  });

  describe("model override priority", () => {
    it("payload model overrides configured default", async () => {
      await withTempHome(async (home) => {
        const { res, call } = await runCronWithModel(
          home,
          "anthropic/claude-sonnet-4-5",
          {
            agents: {
              defaults: {
                model: "anthropic/claude-opus-4-5", // default is opus
              },
            },
          },
        );
        expect(res.status).toBe("ok");
        expect(call.provider).toBe("anthropic");
        expect(call.model).toBe("claude-sonnet-4-5"); // should use sonnet from payload
      });
    });

    it("payload model overrides subagents.model config", async () => {
      await withTempHome(async (home) => {
        const { res, call } = await runCronWithModel(
          home,
          "anthropic/claude-opus-4-5",
          {
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-5",
                subagents: {
                  model: "openai/gpt-4.1-mini", // subagent override
                },
              },
            },
          },
        );
        expect(res.status).toBe("ok");
        expect(call.provider).toBe("anthropic");
        expect(call.model).toBe("claude-opus-4-5"); // payload should win
      });
    });
  });
});
