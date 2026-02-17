import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("per-agent thinkingDefault", () => {
  it("accepts valid thinkingDefault values on agents.list entries", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          { id: "main", thinkingDefault: "medium" },
          { id: "research", thinkingDefault: "xhigh" },
        ],
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects invalid thinkingDefault values on agents.list entries", () => {
    const res = validateConfigObject({
      agents: {
        list: [{ id: "main", thinkingDefault: "ultra" }],
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("agents.list.0.thinkingDefault");
    }
  });
});
