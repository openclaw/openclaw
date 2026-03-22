import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearConfigCache, loadConfig } from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("config subagent escalation settings", () => {
  beforeEach(() => {
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("preserves default and per-agent subagent escalation settings", async () => {
    await withTempHomeConfig(
      {
        agents: {
          defaults: {
            subagents: {
              model: "anthropic/claude-haiku-4-5",
              escalation: {
                enabled: true,
                moderateModel: "anthropic/claude-sonnet-4-6",
                complexModel: "anthropic/claude-opus-4-1",
              },
            },
          },
          list: [
            {
              id: "research",
              subagents: {
                escalation: {
                  enabled: true,
                  moderateModel: "openai/gpt-5.3-codex",
                  complexModel: "openai/gpt-5.4",
                },
              },
            },
          ],
        },
      },
      async () => {
        const cfg = loadConfig();
        expect(cfg.agents?.defaults?.subagents?.escalation).toEqual({
          enabled: true,
          moderateModel: "anthropic/claude-sonnet-4-6",
          complexModel: "anthropic/claude-opus-4-1",
        });
        expect(cfg.agents?.list?.[0]?.subagents?.escalation).toEqual({
          enabled: true,
          moderateModel: "openai/gpt-5.3-codex",
          complexModel: "openai/gpt-5.4",
        });
      },
    );
  });

  async function expectInvalidEscalationConfig(config: unknown, messagePattern: RegExp) {
    await withTempHomeConfig(config, async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      let thrown: unknown;
      try {
        loadConfig();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as { code?: string } | undefined)?.code).toBe("INVALID_CONFIG");
      expect((thrown as Error).message).toMatch(messagePattern);
      expect(consoleSpy).toHaveBeenCalled();
    });
  }

  it("rejects enabled defaults escalation without both tier models", async () => {
    await expectInvalidEscalationConfig(
      {
        agents: {
          defaults: {
            subagents: {
              escalation: {
                enabled: true,
                moderateModel: "anthropic/claude-sonnet-4-6",
              },
            },
          },
        },
      },
      /moderateModel|complexModel|subagent escalation/i,
    );
  });

  it("rejects enabled per-agent escalation without both tier models", async () => {
    await expectInvalidEscalationConfig(
      {
        agents: {
          list: [
            {
              id: "research",
              subagents: {
                escalation: {
                  enabled: true,
                  complexModel: "anthropic/claude-opus-4-1",
                },
              },
            },
          ],
        },
      },
      /moderateModel|complexModel|subagent escalation/i,
    );
  });

  it("rejects null escalation values during config load", async () => {
    await expectInvalidEscalationConfig(
      {
        agents: {
          defaults: {
            subagents: {
              escalation: {
                enabled: null,
                moderateModel: null,
                complexModel: null,
              },
            },
          },
        },
      },
      /enabled|moderateModel|complexModel|subagents/i,
    );
  });
});
