import { describe, expect, it } from "vitest";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";

describe("resolvePluginControlPlaneWorkspace", () => {
  it("uses the configured system agent for control-plane workspace enrichment", () => {
    expect(
      resolvePluginControlPlaneWorkspace({
        config: {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "beta" } },
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: "/tmp/beta" },
            },
          },
        },
        env: {},
      }),
    ).toEqual({
      agentId: "beta",
      workspaceDir: "/tmp/beta",
      workspaceScope: "selected",
    });
  });
});
