import { describe, expect, it, vi } from "vitest";
import { listRouteBindings, synthesizeDiscordAccountBindings } from "./bindings.js";
import type { OpenClawConfig } from "./config.js";
import type { AgentRouteBinding } from "./types.agents.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    agents: { list: [{ id: "main" }] },
    ...overrides,
  } as OpenClawConfig;
}

describe("synthesizeDiscordAccountBindings", () => {
  it("creates a binding for an account with a valid agentId", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([
      { agentId: "theodore", match: { channel: "discord", accountId: "theodore" } },
    ]);
  });

  it("skips accounts with an agentId not in agents.list (fail-secure)", async () => {
    const { logWarn } = await import("../logger.js");
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }] },
      channels: {
        discord: {
          accounts: {
            rogue: { agentId: "nonexistent" },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("does not exist in agents.list"));
  });

  it("skips accounts without agentId (backward compatible)", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          accounts: {
            default: {},
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toHaveLength(1);
    expect(result[0].match.accountId).toBe("theodore");
  });

  it("synthesizes bindings for multiple accounts simultaneously", () => {
    const cfg = makeConfig({
      agents: {
        list: [
          { id: "main" },
          { id: "theodore" },
          { id: "gordon" },
          { id: "wanda" },
          { id: "gerald" },
          { id: "sandy" },
        ],
      },
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
            gordon: { agentId: "gordon" },
            wanda: { agentId: "wanda" },
            gerald: { agentId: "gerald" },
            sandy: { agentId: "sandy" },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toHaveLength(5);
    const accountIds = result.map((b) => b.match.accountId);
    expect(accountIds).toContain("theodore");
    expect(accountIds).toContain("gordon");
    expect(accountIds).toContain("wanda");
    expect(accountIds).toContain("gerald");
    expect(accountIds).toContain("sandy");
  });

  it("explicit bindings take precedence over synthesized ones", async () => {
    const { logWarn } = await import("../logger.js");
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const explicitBindings: AgentRouteBinding[] = [
      { agentId: "main", match: { channel: "discord", accountId: "theodore" } },
    ];
    const result = synthesizeDiscordAccountBindings(cfg, explicitBindings);
    expect(result).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("explicit binding takes precedence"),
    );
  });

  it("matches agentId case-insensitively via normalizeAgentId", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "Theodore" }] },
      channels: {
        discord: {
          accounts: {
            theo: { agentId: "theodore" },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("theodore");
  });

  it("returns empty array when no discord accounts exist", () => {
    const cfg = makeConfig({ agents: { list: [{ id: "main" }] } });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([]);
  });

  it("skips accounts with empty agentId after trim", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }] },
      channels: {
        discord: {
          accounts: {
            blank: { agentId: "   " },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([]);
  });

  it("rejects all agentIds when agents.list is empty (fail-secure)", async () => {
    const { logWarn } = await import("../logger.js");
    const cfg = makeConfig({
      agents: { list: [] },
      channels: {
        discord: {
          accounts: {
            rogue: { agentId: "rogue" },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("does not exist in agents.list"));
  });

  it("honors top-level agentId in single-account setups (no accounts map)", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          agentId: "theodore",
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([
      { agentId: "theodore", match: { channel: "discord", accountId: "default" } },
    ]);
  });

  it("account-level agentId overrides top-level agentId", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }, { id: "gordon" }] },
      channels: {
        discord: {
          agentId: "theodore",
          accounts: {
            mybot: { agentId: "gordon" },
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("gordon");
    expect(result[0].match.accountId).toBe("mybot");
  });

  it("accounts without agentId inherit top-level agentId", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          agentId: "theodore",
          accounts: {
            mybot: {},
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("theodore");
    expect(result[0].match.accountId).toBe("mybot");
  });

  it("explicit empty agentId opts out of top-level agent", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          agentId: "theodore",
          accounts: {
            optout: { agentId: "" },
            inherited: {},
          },
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("theodore");
    expect(result[0].match.accountId).toBe("inherited");
  });

  it("ignores top-level agentId when no discord config exists", () => {
    const cfg = makeConfig({ agents: { list: [{ id: "main" }] } });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([]);
  });

  it("recognizes explicit bindings with differently-cased channel and accountId", async () => {
    const { logWarn } = await import("../logger.js");
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const explicitBindings: AgentRouteBinding[] = [
      { agentId: "main", match: { channel: "Discord", accountId: "Theodore" } },
    ];
    const result = synthesizeDiscordAccountBindings(cfg, explicitBindings);
    expect(result).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("explicit binding takes precedence"),
    );
  });

  it("wildcard explicit binding suppresses all synthesized bindings", async () => {
    const { logWarn } = await import("../logger.js");
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }, { id: "gordon" }] },
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
            gordon: { agentId: "gordon" },
          },
        },
      },
    });
    const explicitBindings: AgentRouteBinding[] = [
      { agentId: "main", match: { channel: "discord", accountId: "*" } },
    ];
    const result = synthesizeDiscordAccountBindings(cfg, explicitBindings);
    expect(result).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("explicit binding takes precedence"),
    );
  });

  it("channel-only explicit binding (no accountId) only shadows default account", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          agentId: "theodore",
          accounts: {
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const explicitBindings: AgentRouteBinding[] = [
      { agentId: "main", match: { channel: "discord" } },
    ];
    const result = synthesizeDiscordAccountBindings(cfg, explicitBindings);
    // The channel-only binding maps to "default" account in routing,
    // so theodore's account binding is NOT suppressed.
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("theodore");
    expect(result[0].match.accountId).toBe("theodore");
  });

  it("scoped explicit binding (guildId) does not suppress synthesized bindings", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const explicitBindings: AgentRouteBinding[] = [
      { agentId: "main", match: { channel: "discord", guildId: "12345" } },
    ];
    const result = synthesizeDiscordAccountBindings(cfg, explicitBindings);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("theodore");
  });

  it("scoped account binding (accountId + guildId) does not suppress synthesized binding", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const explicitBindings: AgentRouteBinding[] = [
      {
        agentId: "main",
        match: { channel: "discord", accountId: "theodore", guildId: "12345" },
      },
    ];
    const result = synthesizeDiscordAccountBindings(cfg, explicitBindings);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("theodore");
  });

  it("treats empty accounts map as implicit default account", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      channels: {
        discord: {
          agentId: "theodore",
          accounts: {},
        },
      },
    });
    const result = synthesizeDiscordAccountBindings(cfg, []);
    expect(result).toEqual([
      { agentId: "theodore", match: { channel: "discord", accountId: "default" } },
    ]);
  });
});

describe("listRouteBindings", () => {
  it("returns only explicit bindings without synthesized ones", () => {
    const cfg = makeConfig({
      agents: { list: [{ id: "main" }, { id: "theodore" }] },
      bindings: [{ agentId: "main", match: { channel: "discord" } }],
      channels: {
        discord: {
          accounts: {
            theodore: { agentId: "theodore" },
          },
        },
      },
    });
    const result = listRouteBindings(cfg);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe("main");
  });
});
