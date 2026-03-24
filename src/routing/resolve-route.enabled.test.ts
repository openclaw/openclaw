import { describe, expect, it } from "vitest";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { pickFirstExistingAgentId } from "./resolve-route.js";

describe("routing with disabled agents", () => {
  const cfg: OpenClawConfig = {
    agents: {
      list: [{ id: "main", default: true }, { id: "worker" }, { id: "suspended", enabled: false }],
    },
  };

  describe("pickFirstExistingAgentId", () => {
    it("resolves enabled agent normally", () => {
      expect(pickFirstExistingAgentId(cfg, "worker")).toBe("worker");
    });

    it("returns fallback for disabled agent", () => {
      const result = pickFirstExistingAgentId(cfg, "suspended");
      expect(result).toBe("main");
    });

    it("resolves agent with no enabled field", () => {
      expect(pickFirstExistingAgentId(cfg, "main")).toBe("main");
    });

    it("resolves agent with enabled: true", () => {
      const cfgExplicit: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "active", enabled: true },
          ],
        },
      };
      expect(pickFirstExistingAgentId(cfgExplicit, "active")).toBe("active");
    });

    it("falls back to default when all non-default agents are disabled", () => {
      const cfgAllDisabled: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "a", enabled: false },
            { id: "b", enabled: false },
          ],
        },
      };
      expect(pickFirstExistingAgentId(cfgAllDisabled, "a")).toBe("main");
      expect(pickFirstExistingAgentId(cfgAllDisabled, "b")).toBe("main");
    });
  });

  describe("listAgentIds", () => {
    it("excludes disabled agents", () => {
      const ids = listAgentIds(cfg);
      expect(ids).toContain("main");
      expect(ids).toContain("worker");
      expect(ids).not.toContain("suspended");
    });

    it("returns default agent id when all agents are disabled", () => {
      const cfgAllDisabled: OpenClawConfig = {
        agents: {
          list: [{ id: "only", enabled: false }],
        },
      };
      const ids = listAgentIds(cfgAllDisabled);
      expect(ids).toEqual(["main"]);
    });
  });

  describe("resolveDefaultAgentId", () => {
    it("skips disabled agents when resolving default", () => {
      const cfgDisabledDefault: OpenClawConfig = {
        agents: {
          list: [{ id: "first", enabled: false }, { id: "second" }],
        },
      };
      expect(resolveDefaultAgentId(cfgDisabledDefault)).toBe("second");
    });

    it("uses first enabled agent as default when no default is set", () => {
      const result = resolveDefaultAgentId(cfg);
      expect(result).toBe("main");
    });
  });
});
