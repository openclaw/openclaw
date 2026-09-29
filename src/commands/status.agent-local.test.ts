import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectStatusLocalSnapshot } from "./status.agent-local.js";
import { buildStatusAgentsValue } from "./status.command-sections.js";

it("does not project the gateway's compatibility id as an explicit fleet default", async () => {
  await withOpenClawTestState({ label: "status-explicit-fleet" }, async () => {
    const { agentStatus } = await collectStatusLocalSnapshot({
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    });
    expect(agentStatus).toMatchObject({
      defaultId: null,
      ownership: "explicit",
      selectionRequired: true,
      agents: [{ id: "alpha" }, { id: "beta" }],
    });
    expect(buildStatusAgentsValue({ agentStatus, formatTimeAgo: () => "now" })).toBe(
      "2 · no workspaces bootstrapping · sessions 0",
    );
  });
});
