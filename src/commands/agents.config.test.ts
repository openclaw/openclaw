import { describe, expect, it } from "vitest";
import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setDefaultAgent } from "./agents.config.js";

function configWith(list: Array<{ id: string; default?: boolean }>): OpenClawConfig {
  return { agents: { list } } as unknown as OpenClawConfig;
}

describe("setDefaultAgent", () => {
  it("flags the target and clears the previous default", () => {
    const cfg = configWith([{ id: "main", default: true }, { id: "research" }]);

    const next = setDefaultAgent(cfg, "research");

    expect(next.agents?.list).toEqual([
      { id: "main", default: false },
      { id: "research", default: true },
    ]);
    expect(resolveDefaultAgentId(next)).toBe("research");
  });

  it("normalizes the requested id before matching", () => {
    const cfg = configWith([{ id: "main", default: true }, { id: "research" }]);

    const next = setDefaultAgent(cfg, "  Research  ");

    expect(resolveDefaultAgentId(next)).toBe("research");
    expect(next.agents?.list?.filter((entry) => entry.default)).toHaveLength(1);
  });

  it("leaves entries untouched when the target is already the sole default", () => {
    const cfg = configWith([{ id: "main", default: true }, { id: "research" }]);

    const next = setDefaultAgent(cfg, "main");

    // Unchanged entries keep referential identity so the config write stays minimal.
    expect(next.agents?.list?.[0]).toBe(cfg.agents?.list?.[0]);
    expect(next.agents?.list?.[1]).toBe(cfg.agents?.list?.[1]);
    expect(resolveDefaultAgentId(next)).toBe("main");
  });

  it("collapses multiple stray defaults down to the chosen target", () => {
    const cfg = configWith([
      { id: "main", default: true },
      { id: "research", default: true },
      { id: "ops" },
    ]);

    const next = setDefaultAgent(cfg, "ops");

    expect(next.agents?.list).toEqual([
      { id: "main", default: false },
      { id: "research", default: false },
      { id: "ops", default: true },
    ]);
    expect(resolveDefaultAgentId(next)).toBe("ops");
  });
});
