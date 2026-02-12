import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentBinding } from "../config/types.agents.js";
import {
  buildChannelAccountBindings,
  listBindings,
  listBoundAccountIds,
  resolveDefaultAgentBoundAccountId,
  resolvePreferredAccountId,
} from "./bindings.js";

// Mock agent-scope to avoid importing transitive dependencies
vi.mock("../agents/agent-scope.js", () => {
  return {
    resolveDefaultAgentId: (cfg: OpenClawConfig) => {
      const list = cfg.agents?.list;
      if (!Array.isArray(list) || list.length === 0) {
        return "main";
      }
      const defaults = list.filter((a: any) => a.default);
      const chosen = (defaults[0] ?? list[0])?.id?.trim();
      return chosen || "main";
    },
  };
});

// Mock channels/registry to avoid importing transitive dependencies
vi.mock("../channels/registry.js", () => {
  return {
    normalizeChatChannelId: (raw: string | undefined | null) => {
      const normalized = (raw ?? "").trim().toLowerCase();
      if (!normalized) return null;
      // Mock known channels
      const known = ["discord", "telegram", "whatsapp", "slack", "signal", "imessage", "googlechat"];
      if (normalized === "imsg") return "imessage";
      if (known.includes(normalized)) return normalized;
      return null;
    }
  };
});

describe("Agent Bindings Logic", () => {
  describe("listBindings", () => {
    it("returns empty array for empty config", () => {
      const cfg: OpenClawConfig = {};
      expect(listBindings(cfg)).toEqual([]);
    });

    it("returns empty array when bindings is not an array", () => {
      const cfg = { bindings: "invalid" } as unknown as OpenClawConfig;
      expect(listBindings(cfg)).toEqual([]);
    });

    it("returns bindings array from config", () => {
      const bindings: AgentBinding[] = [
        { agentId: "test", match: { channel: "test" } },
      ];
      const cfg: OpenClawConfig = { bindings };
      expect(listBindings(cfg)).toBe(bindings);
    });
  });

  describe("listBoundAccountIds", () => {
    const bindings: AgentBinding[] = [
      {
        agentId: "agent1",
        match: { channel: "discord", accountId: "acc1" },
      },
      {
        agentId: "agent2",
        match: { channel: "discord", accountId: "acc2" },
      },
      {
        agentId: "agent3",
        match: { channel: "telegram", accountId: "acc3" },
      },
      {
        agentId: "agent4",
        match: { channel: "discord", accountId: "*" }, // Wildcard should be ignored
      },
      {
        agentId: "agent5",
        match: { channel: "discord" }, // Missing accountId should be ignored
      },
    ];
    const cfg: OpenClawConfig = { bindings };

    it("returns matching account IDs for a channel", () => {
      const result = listBoundAccountIds(cfg, "discord");
      expect(result).toEqual(["acc1", "acc2"]);
    });

    it("returns empty array for unknown channel", () => {
      const result = listBoundAccountIds(cfg, "slack");
      expect(result).toEqual([]);
    });

    it("normalizes channel ID (case insensitive)", () => {
      const result = listBoundAccountIds(cfg, " DISCORD ");
      expect(result).toEqual(["acc1", "acc2"]);
    });

    it("normalizes binding channel ID (case insensitive)", () => {
      const customBindings: AgentBinding[] = [
        {
          agentId: "agent1",
          match: { channel: " MyChannel ", accountId: "acc1" },
        },
      ];
      const customCfg: OpenClawConfig = { bindings: customBindings };
      const result = listBoundAccountIds(customCfg, "mychannel");
      expect(result).toEqual(["acc1"]);
    });
  });

  describe("resolveDefaultAgentBoundAccountId", () => {
    const bindings: AgentBinding[] = [
      {
        agentId: "main",
        match: { channel: "discord", accountId: "main-acc" },
      },
      {
        agentId: "other",
        match: { channel: "discord", accountId: "other-acc" },
      },
    ];
    const cfg: OpenClawConfig = { bindings };

    it("resolves account ID for default agent (main)", () => {
      const result = resolveDefaultAgentBoundAccountId(cfg, "discord");
      expect(result).toBe("main-acc");
    });

    it("returns null if no binding for default agent", () => {
      const result = resolveDefaultAgentBoundAccountId(cfg, "telegram");
      expect(result).toBeNull();
    });

    it("resolves account ID for custom default agent", () => {
      const customCfg: OpenClawConfig = {
        agents: {
          list: [{ id: "custom", default: true }],
        },
        bindings: [
          {
            agentId: "custom",
            match: { channel: "discord", accountId: "custom-acc" },
          },
        ],
      };
      const result = resolveDefaultAgentBoundAccountId(customCfg, "discord");
      expect(result).toBe("custom-acc");
    });
  });

  describe("buildChannelAccountBindings", () => {
    it("builds map of channel -> agent -> accounts", () => {
      const bindings: AgentBinding[] = [
        {
          agentId: "agent1",
          match: { channel: "discord", accountId: "acc1" },
        },
        {
          agentId: "agent1", // Same agent, different account
          match: { channel: "discord", accountId: "acc2" },
        },
        {
          agentId: "agent2",
          match: { channel: "discord", accountId: "acc3" },
        },
        {
          agentId: "agent1", // Different channel
          match: { channel: "telegram", accountId: "acc4" },
        },
      ];
      const cfg: OpenClawConfig = { bindings };
      const map = buildChannelAccountBindings(cfg);

      expect(map.size).toBe(2);
      expect(map.has("discord")).toBe(true);
      expect(map.has("telegram")).toBe(true);

      const discordMap = map.get("discord")!;
      expect(discordMap.get("agent1")).toEqual(["acc1", "acc2"]);
      expect(discordMap.get("agent2")).toEqual(["acc3"]);

      const telegramMap = map.get("telegram")!;
      expect(telegramMap.get("agent1")).toEqual(["acc4"]);
    });
  });

  describe("resolvePreferredAccountId", () => {
    it("returns first bound account if available", () => {
      const result = resolvePreferredAccountId({
        accountIds: ["acc1", "acc2"],
        defaultAccountId: "default-acc",
        boundAccounts: ["bound-acc1", "bound-acc2"],
      });
      expect(result).toBe("bound-acc1");
    });

    it("returns default account if no bound accounts", () => {
      const result = resolvePreferredAccountId({
        accountIds: ["acc1", "acc2"],
        defaultAccountId: "default-acc",
        boundAccounts: [],
      });
      expect(result).toBe("default-acc");
    });
  });
});
