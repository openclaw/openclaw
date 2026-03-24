import { describe, expect, it } from "vitest";
import { listAgentEntries, listAllAgentEntries } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentConfig,
  buildAgentSummaries,
  findAgentEntryIndex,
  pruneAgentConfig,
} from "./agents.config.js";

describe("agents.list[].enabled field", () => {
  const baseCfg: OpenClawConfig = {
    agents: {
      list: [{ id: "main" }, { id: "worker", enabled: true }, { id: "suspended", enabled: false }],
    },
  };

  describe("listAgentEntries (enabled-only filter)", () => {
    it("excludes agents with enabled: false", () => {
      const entries = listAgentEntries(baseCfg);
      const ids = entries.map((e) => e.id);
      expect(ids).toContain("main");
      expect(ids).toContain("worker");
      expect(ids).not.toContain("suspended");
    });

    it("includes agents with no enabled field (defaults to active)", () => {
      const entries = listAgentEntries(baseCfg);
      expect(entries.find((e) => e.id === "main")).toBeTruthy();
    });

    it("includes agents with enabled: true", () => {
      const entries = listAgentEntries(baseCfg);
      expect(entries.find((e) => e.id === "worker")).toBeTruthy();
    });

    it("returns empty array when all agents are disabled", () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "a", enabled: false }] },
      };
      expect(listAgentEntries(cfg)).toHaveLength(0);
    });

    it("returns empty array for missing agents list", () => {
      expect(listAgentEntries({})).toHaveLength(0);
    });
  });

  describe("listAllAgentEntries (includes disabled)", () => {
    it("returns all agents including disabled ones", () => {
      const entries = listAllAgentEntries(baseCfg);
      const ids = entries.map((e) => e.id);
      expect(ids).toContain("main");
      expect(ids).toContain("worker");
      expect(ids).toContain("suspended");
    });

    it("returns agents in original order", () => {
      const entries = listAllAgentEntries(baseCfg);
      expect(entries[0].id).toBe("main");
      expect(entries[1].id).toBe("worker");
      expect(entries[2].id).toBe("suspended");
    });
  });

  describe("findAgentEntryIndex with disabled agents", () => {
    it("finds disabled agent in full list", () => {
      const all = listAllAgentEntries(baseCfg);
      expect(findAgentEntryIndex(all, "suspended")).toBe(2);
    });

    it("does not find disabled agent in enabled-only list", () => {
      const enabled = listAgentEntries(baseCfg);
      expect(findAgentEntryIndex(enabled, "suspended")).toBe(-1);
    });
  });

  describe("buildAgentSummaries with disabled agents", () => {
    it("includes disabled agents in summaries", () => {
      const summaries = buildAgentSummaries(baseCfg);
      const ids = summaries.map((s) => s.id);
      expect(ids).toContain("suspended");
    });

    it("marks disabled agents with enabled: false", () => {
      const summaries = buildAgentSummaries(baseCfg);
      const suspended = summaries.find((s) => s.id === "suspended");
      expect(suspended?.enabled).toBe(false);
    });

    it("marks enabled agents with enabled: true", () => {
      const summaries = buildAgentSummaries(baseCfg);
      const worker = summaries.find((s) => s.id === "worker");
      expect(worker?.enabled).toBe(true);
    });

    it("marks agents without enabled field as enabled: true", () => {
      const summaries = buildAgentSummaries(baseCfg);
      const main = summaries.find((s) => s.id === "main");
      expect(main?.enabled).toBe(true);
    });

    it("shows name and model for disabled agents", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "anthropic/claude" } },
          list: [
            { id: "main" },
            { id: "suspended", enabled: false, name: "Suspended Bot", model: "openai/gpt-4.1" },
          ],
        },
      };
      const summaries = buildAgentSummaries(cfg);
      const suspended = summaries.find((s) => s.id === "suspended");
      expect(suspended?.name).toBe("Suspended Bot");
      expect(suspended?.model).toBe("openai/gpt-4.1");
    });
  });

  describe("applyAgentConfig preserves disabled agents", () => {
    it("does not drop disabled agents when adding a new agent", () => {
      const result = applyAgentConfig(baseCfg, {
        agentId: "new-bot",
        workspace: "/new-ws",
      });
      const ids = result.agents?.list?.map((a) => a.id) ?? [];
      expect(ids).toContain("suspended");
      expect(ids).toContain("new-bot");
      expect(ids).toContain("main");
    });

    it("does not drop disabled agents when updating an existing agent", () => {
      const result = applyAgentConfig(baseCfg, {
        agentId: "worker",
        name: "Updated Worker",
      });
      const ids = result.agents?.list?.map((a) => a.id) ?? [];
      expect(ids).toContain("suspended");
      const suspended = result.agents?.list?.find((a) => a.id === "suspended");
      expect(suspended?.enabled).toBe(false);
    });
  });

  describe("pruneAgentConfig preserves disabled agents", () => {
    it("keeps disabled agents when deleting an enabled agent", () => {
      const result = pruneAgentConfig(baseCfg, "worker");
      const ids = result.config.agents?.list?.map((a) => a.id) ?? [];
      expect(ids).toContain("suspended");
      expect(ids).not.toContain("worker");
    });

    it("can delete a disabled agent", () => {
      const result = pruneAgentConfig(baseCfg, "suspended");
      const ids = result.config.agents?.list?.map((a) => a.id) ?? [];
      expect(ids).not.toContain("suspended");
      expect(ids).toContain("main");
      expect(ids).toContain("worker");
    });
  });
});
