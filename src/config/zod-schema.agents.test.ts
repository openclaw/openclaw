import { describe, expect, it } from "vitest";
import { AgentsSchema } from "./zod-schema.agents.js";

describe("AgentsSchema", () => {
  it.each(["openclaw", "crestodian"])("rejects reserved system agent id %s", (id) => {
    const result = AgentsSchema.safeParse({ list: [{ id, default: true }] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["list", 0, "id"],
      message: `Agent id "${id}" is reserved for the system agent.`,
    });
  });

  it("accepts ordinary agent ids", () => {
    expect(AgentsSchema.safeParse({ list: [{ id: "main", default: true }] }).success).toBe(true);
  });
});
