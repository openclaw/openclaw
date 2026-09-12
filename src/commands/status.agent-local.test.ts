import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getAgentLocalStatuses } from "./status.agent-local.js";

describe("getAgentLocalStatuses", () => {
  it("does not project the gateway's compatibility id as an explicit fleet default", async () => {
    await withOpenClawTestState({ label: "status-explicit-fleet" }, async () => {
      await expect(
        getAgentLocalStatuses({
          agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
        }),
      ).resolves.toMatchObject({
        defaultId: null,
        ownership: "explicit",
        selectionRequired: true,
        agents: [{ id: "alpha" }, { id: "beta" }],
      });
    });
  });

  it("preserves a resolved sole owner", async () => {
    await withOpenClawTestState({ label: "status-sole-owner" }, async (state) => {
      const sessionsDir = path.join(state.root, "alpha");
      await expect(
        getAgentLocalStatuses({
          agents: { entries: { alpha: {} } },
          session: { store: path.join(sessionsDir, "sessions.json") },
        }),
      ).resolves.toMatchObject({
        defaultId: "alpha",
        ownership: "sole",
        selectionRequired: false,
        agents: [
          { id: "alpha", sessionsPath: path.join(sessionsDir, "openclaw-agent.alpha.sqlite") },
        ],
      });
    });
  });
});
