import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNodeScopedToolPolicy } from "./node-tool-policy.js";

const NODE = "node-abc";

function cfg(byNode: Record<string, { allow?: string[]; deny?: string[] }>): OpenClawConfig {
  return { gateway: { tools: { byNode } } };
}

describe("resolveNodeScopedToolPolicy (run-scoped gateway.tools.byNode)", () => {
  it("returns the node's allow/deny for the explicit hosting node", () => {
    expect(
      resolveNodeScopedToolPolicy(NODE, cfg({ [NODE]: { allow: ["browser"], deny: ["exec"] } })),
    ).toEqual({ nodeAllow: ["browser"], nodeDeny: ["exec"] });
  });

  it("treats an explicitly-present empty allow as fail-closed (empty array, not undefined)", () => {
    expect(resolveNodeScopedToolPolicy(NODE, cfg({ [NODE]: { allow: [] } }))).toEqual({
      nodeAllow: [],
      nodeDeny: [],
    });
  });

  it("absent allow yields no allow gate, deny only", () => {
    expect(resolveNodeScopedToolPolicy(NODE, cfg({ [NODE]: { deny: ["exec"] } }))).toEqual({
      nodeAllow: undefined,
      nodeDeny: ["exec"],
    });
  });

  it("is a no-op when the run carries no hosting node (non-node-originated turn)", () => {
    expect(resolveNodeScopedToolPolicy(undefined, cfg({ [NODE]: { allow: ["browser"] } }))).toEqual(
      { nodeDeny: [] },
    );
  });

  it("is a no-op when the hosting node has no byNode entry", () => {
    expect(
      resolveNodeScopedToolPolicy("some-other-node", cfg({ [NODE]: { allow: ["browser"] } })),
    ).toEqual({ nodeDeny: [] });
  });
});
