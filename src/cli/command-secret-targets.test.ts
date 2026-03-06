import { describe, expect, it } from "vitest";
import {
  getAgentRuntimeCommandSecretTargetIds,
  getMemoryCommandSecretTargetIds,
  getStatusCommandSecretTargetIds,
} from "./command-secret-targets.js";

describe("command secret target ids", () => {
  it("includes memorySearch remote targets for agent runtime commands", () => {
    const ids = getAgentRuntimeCommandSecretTargetIds();
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("agents.list[].memorySearch.remote.apiKey")).toBe(true);
  });

  it("keeps memory command target set focused on memorySearch remote credentials", () => {
    const ids = getMemoryCommandSecretTargetIds();
    expect(ids).toEqual(
      new Set([
        "agents.defaults.memorySearch.remote.apiKey",
        "agents.list[].memorySearch.remote.apiKey",
      ]),
    );
  });

  it("includes web search secret targets for status commands", () => {
    const ids = getStatusCommandSecretTargetIds();
    expect(ids.has("tools.web.search.apiKey")).toBe(true);
    expect(ids.has("tools.web.search.perplexity.apiKey")).toBe(true);
    expect(ids.has("tools.web.search.grok.apiKey")).toBe(true);
    expect(ids.has("tools.web.search.gemini.apiKey")).toBe(true);
    expect(ids.has("tools.web.search.kimi.apiKey")).toBe(true);
  });
});
