import { describe, expect, it } from "vitest";
import { newSessionDataFromSearch, newSessionSearch } from "./location.ts";

describe("new-session location", () => {
  it("round-trips a catalog creation target", () => {
    const search = newSessionSearch("main/agent", {
      model: "anthropic/claude-opus-4-8",
      label: "Claude Code",
    });

    expect(search).toBe(
      "?agent=main%2Fagent&model=anthropic%2Fclaude-opus-4-8&catalog=Claude+Code",
    );
    expect(newSessionDataFromSearch(search)).toEqual({
      agentId: "main/agent",
      model: "anthropic/claude-opus-4-8",
      catalogLabel: "Claude Code",
    });
  });

  it("keeps the plain entry point empty", () => {
    expect(newSessionSearch("")).toBe("");
    expect(newSessionDataFromSearch("")).toEqual({
      agentId: "",
      model: "",
      catalogLabel: "",
    });
  });
});
