import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyCapabilitySlotSelection,
  resolveCapabilitySlotSelection,
} from "./capability-slots.js";

describe("capability slot selection", () => {
  it("resolves the configured search provider from web search config", () => {
    const config: OpenClawConfig = {
      tools: { web: { search: { provider: "tavily" } } },
    };

    expect(resolveCapabilitySlotSelection(config, "providers.search")).toBe("tavily");
  });

  it("applies search slot selection through the web search provider field", () => {
    const config: OpenClawConfig = {
      tools: { web: { search: { provider: "brave" } } },
    };

    const next = applyCapabilitySlotSelection({
      config,
      slot: "providers.search",
      selectedId: "tavily",
    });

    expect(next.tools?.web?.search?.provider).toBe("tavily");
  });

  it("resolves the effective memory backend selection with default fallback", () => {
    expect(resolveCapabilitySlotSelection({}, "memory.backend")).toBe("memory-core");
  });

  it("applies memory backend selection through plugins.slots.memory", () => {
    const next = applyCapabilitySlotSelection({
      config: {},
      slot: "memory.backend",
      selectedId: "memory-alt",
    });

    expect(next.plugins?.slots?.memory).toBe("memory-alt");
  });

  it("supports disabling the memory backend slot", () => {
    const next = applyCapabilitySlotSelection({
      config: {},
      slot: "memory.backend",
      selectedId: null,
    });

    expect(next.plugins?.slots?.memory).toBe("none");
  });
});
