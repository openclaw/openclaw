import { describe, expect, it } from "vitest";
import { listSelectableAgents } from "./roster.ts";

describe("listSelectableAgents", () => {
  it("excludes semantic system rows without depending on identity", () => {
    const agents = [
      { id: "main", kind: "agent" as const },
      { id: "ordinary-looking-id", kind: "system" as const },
      { id: "legacy-gateway-row" },
    ];

    expect(listSelectableAgents(agents)).toEqual([agents[0], agents[2]]);
    expect(agents).toHaveLength(3);
  });
});
