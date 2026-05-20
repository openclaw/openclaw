import { describe, expect, it } from "vitest";
import {
  findUndeclaredPluginToolNames,
  normalizePluginToolContractNames,
} from "./tool-contracts.js";

describe("plugin tool contracts wildcard", () => {
  it("treats contracts.tools: ['*'] as declaring any tool name (issue #80621)", () => {
    const declaredNames = normalizePluginToolContractNames({ tools: ["*"] });
    expect(declaredNames).toEqual(["*"]);

    const undeclared = findUndeclaredPluginToolNames({
      declaredNames,
      toolNames: ["arbitrary_tool_name", "another_one"],
    });
    expect(undeclared).toEqual([]);
  });

  it("still rejects unknown names when no wildcard is declared", () => {
    const declaredNames = normalizePluginToolContractNames({ tools: ["known"] });
    const undeclared = findUndeclaredPluginToolNames({
      declaredNames,
      toolNames: ["known", "unknown"],
    });
    expect(undeclared).toEqual(["unknown"]);
  });
});
