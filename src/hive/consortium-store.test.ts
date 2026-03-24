import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { mergeConsortiumDefinitions, resolveConsortiumPeerAgentIds } from "./consortium-store.js";

describe("consortium-store", () => {
  it("mergeConsortiumDefinitions reads config hive consortiums", () => {
    const cfg = {
      skills: {
        hive: {
          consortiums: [{ id: "c1", memberAgentIds: ["a", "b"], label: "lab" }],
        },
      },
    } as unknown as OpenClawConfig;
    const rows = mergeConsortiumDefinitions(cfg);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("c1");
    expect(rows[0]?.memberAgentIds).toEqual(["a", "b"]);
  });

  it("resolveConsortiumPeerAgentIds returns peer union", () => {
    const peers = resolveConsortiumPeerAgentIds("a", [
      { id: "c1", memberAgentIds: ["a", "b"] },
      { id: "c2", memberAgentIds: ["x", "y"] },
    ]);
    expect([...peers].toSorted()).toEqual(["a", "b"]);
  });
});
