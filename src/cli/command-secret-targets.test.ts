import { describe, expect, it } from "vitest";
import {
  getAgentRuntimeCommandSecretTargetIds,
  getMemoryCommandSecretTargetIds,
  getPluginsCommandSecretTargetIds,
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

  it("keeps plugins command target set focused on channel credentials", () => {
    const ids = getPluginsCommandSecretTargetIds();
    expect(ids.has("channels.feishu.appSecret")).toBe(true);
    expect(ids.has("channels.feishu.accounts.*.appSecret")).toBe(true);
    expect(ids.has("agents.defaults.memorySearch.remote.apiKey")).toBe(false);
  });
});
