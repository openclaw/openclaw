import { describe, expect, it } from "vitest";
import {
  getAgentRuntimeCommandSecretTargetIds,
  getMemoryCommandSecretTargetIds,
} from "./command-secret-targets.js";

describe("command secret target ids", () => {
  it("includes memorySearch remote targets for agent runtime commands", () => {
    const ids = getAgentRuntimeCommandSecretTargetIds();
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("agents.list[].memorySearch.remote.apiKey")).toBe(true);
    expect(ids.has("tools.web.fetch.firecrawl.apiKey")).toBe(true);
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
});
