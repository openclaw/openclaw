// Verifies generated config documentation baselines stay stable.
import { describe, expect, it } from "vitest";
import {
  collectConfigDocBaselineEntries,
  dedupeConfigDocBaselineEntries,
<<<<<<< HEAD
} from "./doc-baseline.js";

describe("config doc baseline", () => {
=======
  normalizeConfigDocBaselineHelpPath,
} from "./doc-baseline.js";

describe("config doc baseline", () => {
  it("normalizes array and record paths to wildcard form", () => {
    expect(normalizeConfigDocBaselineHelpPath("agents.list[].skills")).toBe("agents.list.*.skills");
    expect(normalizeConfigDocBaselineHelpPath("session.sendPolicy.rules[0].match.keyPrefix")).toBe(
      "session.sendPolicy.rules.*.match.keyPrefix",
    );
    expect(normalizeConfigDocBaselineHelpPath(".env.*.")).toBe("env.*");
  });

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  it("merges tuple item metadata instead of dropping earlier entries", () => {
    const entries = dedupeConfigDocBaselineEntries(
      collectConfigDocBaselineEntries(
        {
          type: "array",
          items: [
            {
              type: "string",
              enum: ["alpha"],
            },
            {
              type: "number",
              enum: [42],
            },
          ],
        },
        {},
        "tupleValues",
      ),
    );
    expect(entries).toEqual([
      {
        path: "tupleValues",
        kind: "core",
        type: "array",
        required: false,
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: true,
      },
      {
        path: "tupleValues.*",
        kind: "core",
        type: ["number", "string"],
        required: false,
        enumValues: ["alpha", 42],
        deprecated: false,
        sensitive: false,
        tags: [],
        hasChildren: false,
      },
    ]);
  });
});
