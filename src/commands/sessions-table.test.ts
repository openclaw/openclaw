// Sessions table tests cover shared display-label formatting.
import { describe, expect, it } from "vitest";
import { formatSessionKeyCell, toSessionDisplayRow } from "./sessions-table.js";

it("displays the causal creator without exposing the retained isolation actor", () => {
  const row = toSessionDisplayRow("agent:main:delegated", {
    sessionId: "delegated",
    updatedAt: 1,
    createdActor: {
      type: "human",
      source: "profile",
      id: "isolation-owner",
      delegatedBy: { type: "human", source: "profile", id: "causal-human" },
    },
    owner: { actor: { type: "human", id: "assigned-owner" } },
  });
  expect(row.createdActor).toEqual({ type: "human", source: "profile", id: "causal-human" });
  expect(row.owner?.actor.id).toBe("assigned-owner");
});

describe("formatSessionKeyCell", () => {
  it.each(["😀", "👩‍💻", "e\u0301"])(
    "keeps complete %s clusters at both summary boundaries",
    (cluster) => {
      const key = `${"a".repeat(15)}${cluster}middle${cluster}${"z".repeat(5)}`;

      const rendered = formatSessionKeyCell(key, false);

      expect(rendered).toBe(`${"a".repeat(15)}${cluster}...${cluster}${"z".repeat(5)}`);
    },
  );
});
