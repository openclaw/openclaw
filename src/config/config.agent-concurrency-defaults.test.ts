import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_MAX_CONCURRENT,
  DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
  resolveAgentMaxConcurrentPerConversation,
  resolveMaxConcurrentPerConversation,
  resolveSubagentMaxConcurrent,
} from "./agent-limits.js";
import { loadConfig } from "./config.js";
import { withTempHome } from "./test-helpers.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent concurrency defaults", () => {
  it("resolves defaults when unset", () => {
    expect(resolveAgentMaxConcurrent({})).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(resolveSubagentMaxConcurrent({})).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it("clamps invalid values to at least 1", () => {
    const cfg = {
      agents: {
        defaults: {
          maxConcurrent: 0,
          subagents: { maxConcurrent: -3 },
        },
      },
    };
    expect(resolveAgentMaxConcurrent(cfg)).toBe(1);
    expect(resolveSubagentMaxConcurrent(cfg)).toBe(1);
  });

  it("accepts subagent spawn depth and per-agent child limits", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          subagents: {
            maxSpawnDepth: 2,
            maxChildrenPerAgent: 7,
          },
        },
      },
    });

    expect(parsed.agents?.defaults?.subagents?.maxSpawnDepth).toBe(2);
    expect(parsed.agents?.defaults?.subagents?.maxChildrenPerAgent).toBe(7);
  });

  it("resolves per-conversation default when unset", () => {
    expect(resolveAgentMaxConcurrentPerConversation({})).toBe(
      DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION,
    );
  });

  it("resolves per-conversation value when set", () => {
    const cfg = {
      agents: { defaults: { maxConcurrentPerConversation: 3 } },
    };
    expect(resolveAgentMaxConcurrentPerConversation(cfg)).toBe(3);
  });

  it("clamps per-conversation to at least 1", () => {
    const cfg = {
      agents: { defaults: { maxConcurrentPerConversation: 0 } },
    };
    expect(resolveAgentMaxConcurrentPerConversation(cfg)).toBe(1);
  });

  it("accepts maxConcurrentPerConversation in schema", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          maxConcurrentPerConversation: 2,
        },
      },
    });
    expect(parsed.agents?.defaults?.maxConcurrentPerConversation).toBe(2);
  });

  it("injects per-conversation default on load", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({}, null, 2),
        "utf-8",
      );

      const cfg = loadConfig();
      expect(cfg.agents?.defaults?.maxConcurrentPerConversation).toBe(
        DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION,
      );
    });
  });

  it("injects defaults on load", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".openclaw");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "openclaw.json"),
        JSON.stringify({}, null, 2),
        "utf-8",
      );

      const cfg = loadConfig();

      expect(cfg.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
      expect(cfg.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
    });
  });
});

describe("resolveMaxConcurrentPerConversation (per-channel cascade)", () => {
  const globalDefault = DEFAULT_AGENT_MAX_CONCURRENT_PER_CONVERSATION;

  it("returns global default when no config", () => {
    expect(resolveMaxConcurrentPerConversation({})).toBe(globalDefault);
  });

  it("returns global default when channel is missing", () => {
    expect(
      resolveMaxConcurrentPerConversation({
        cfg: { agents: { defaults: { maxConcurrentPerConversation: 5 } } },
      }),
    ).toBe(5);
  });

  // --- Discord cascade: channel → guild → provider → global ---

  it("discord: resolves channel > guild > provider > global", () => {
    const cfg = {
      agents: { defaults: { maxConcurrentPerConversation: 1 } },
      channels: {
        discord: {
          maxConcurrentPerConversation: 2,
          guilds: {
            g1: {
              maxConcurrentPerConversation: 3,
              channels: {
                c1: { maxConcurrentPerConversation: 4 },
              },
            },
          },
        },
      },
    };
    // Channel-level wins
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(4);
  });

  it("discord: falls back to guild when channel not set", () => {
    const cfg = {
      channels: {
        discord: {
          maxConcurrentPerConversation: 2,
          guilds: {
            g1: {
              maxConcurrentPerConversation: 3,
              channels: { c1: {} },
            },
          },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(3);
  });

  it("discord: falls back to provider when guild not set", () => {
    const cfg = {
      channels: {
        discord: {
          maxConcurrentPerConversation: 2,
          guilds: { g1: { channels: { c1: {} } } },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(2);
  });

  it("discord: falls back to global when provider not set", () => {
    const cfg = {
      agents: { defaults: { maxConcurrentPerConversation: 5 } },
      channels: { discord: {} },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:c1",
      }),
    ).toBe(5);
  });

  // --- Telegram cascade: group → provider → global ---

  it("telegram: resolves group > provider > global", () => {
    const cfg = {
      channels: {
        telegram: {
          maxConcurrentPerConversation: 2,
          groups: {
            "100123": { maxConcurrentPerConversation: 3 },
          },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "telegram",
        peerId: "group:100123",
      }),
    ).toBe(3);
  });

  it("telegram: falls back to provider when group not set", () => {
    const cfg = {
      channels: {
        telegram: {
          maxConcurrentPerConversation: 2,
          groups: { "100123": {} },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "telegram",
        peerId: "group:100123",
      }),
    ).toBe(2);
  });

  it("telegram: uses groupSpace when provided", () => {
    const cfg = {
      channels: {
        telegram: {
          groups: { "100123": { maxConcurrentPerConversation: 4 } },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "telegram",
        groupSpace: "100123",
        peerId: "user:999",
      }),
    ).toBe(4);
  });

  // --- Slack cascade: channel → provider → global ---

  it("slack: resolves channel > provider > global", () => {
    const cfg = {
      channels: {
        slack: {
          maxConcurrentPerConversation: 2,
          channels: {
            C0123: { maxConcurrentPerConversation: 3 },
          },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "slack",
        peerId: "channel:C0123",
      }),
    ).toBe(3);
  });

  it("slack: falls back to provider when channel not set", () => {
    const cfg = {
      channels: {
        slack: {
          maxConcurrentPerConversation: 2,
          channels: { C0123: {} },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "slack",
        peerId: "channel:C0123",
      }),
    ).toBe(2);
  });

  // --- peerId prefix stripping ---

  it("strips channel: prefix from peerId", () => {
    const cfg = {
      channels: {
        discord: {
          guilds: {
            g1: {
              channels: { "123456789": { maxConcurrentPerConversation: 5 } },
            },
          },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "discord",
        groupSpace: "g1",
        peerId: "channel:123456789",
      }),
    ).toBe(5);
  });

  it("works with bare peerId (no prefix)", () => {
    const cfg = {
      channels: {
        slack: {
          channels: { C999: { maxConcurrentPerConversation: 7 } },
        },
      },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "slack",
        peerId: "C999",
      }),
    ).toBe(7);
  });

  // --- Flat providers ---

  it("flat provider: falls back to global", () => {
    const cfg = {
      agents: { defaults: { maxConcurrentPerConversation: 3 } },
      channels: { signal: {} },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "signal",
        peerId: "user:abc",
      }),
    ).toBe(3);
  });

  it("flat provider: uses provider-level value", () => {
    const cfg = {
      channels: { matrix: { maxConcurrentPerConversation: 2 } },
    };
    expect(
      resolveMaxConcurrentPerConversation({
        cfg,
        channel: "matrix",
        peerId: "user:abc",
      }),
    ).toBe(2);
  });
});

describe("maxConcurrentPerConversation zod schema validation", () => {
  it("accepts valid values at discord channel level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        discord: {
          guilds: {
            g1: {
              channels: { c1: { maxConcurrentPerConversation: 3 } },
            },
          },
        },
      },
    });
    expect(parsed.channels?.discord?.guilds?.g1?.channels?.c1?.maxConcurrentPerConversation).toBe(
      3,
    );
  });

  it("accepts valid values at discord guild level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        discord: {
          guilds: { g1: { maxConcurrentPerConversation: 5 } },
        },
      },
    });
    expect(parsed.channels?.discord?.guilds?.g1?.maxConcurrentPerConversation).toBe(5);
  });

  it("accepts valid values at discord provider level", () => {
    const parsed = OpenClawSchema.parse({
      channels: { discord: { maxConcurrentPerConversation: 2 } },
    });
    expect(parsed.channels?.discord?.maxConcurrentPerConversation).toBe(2);
  });

  it("accepts valid values at telegram group level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        telegram: {
          groups: { "-100123": { maxConcurrentPerConversation: 4 } },
        },
      },
    });
    expect(parsed.channels?.telegram?.groups?.["-100123"]?.maxConcurrentPerConversation).toBe(4);
  });

  it("accepts valid values at slack channel level", () => {
    const parsed = OpenClawSchema.parse({
      channels: {
        slack: {
          channels: { C0123: { maxConcurrentPerConversation: 2 } },
        },
      },
    });
    expect(parsed.channels?.slack?.channels?.C0123?.maxConcurrentPerConversation).toBe(2);
  });

  it("rejects values below 1", () => {
    expect(() =>
      OpenClawSchema.parse({
        channels: { discord: { maxConcurrentPerConversation: 0 } },
      }),
    ).toThrow();
  });

  it("rejects values above 10", () => {
    expect(() =>
      OpenClawSchema.parse({
        channels: { discord: { maxConcurrentPerConversation: 11 } },
      }),
    ).toThrow();
  });

  it("accepts config without the field (optional)", () => {
    const parsed = OpenClawSchema.parse({
      channels: { discord: {} },
    });
    expect(parsed.channels?.discord?.maxConcurrentPerConversation).toBeUndefined();
  });
});
