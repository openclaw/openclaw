import { expect, it } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import {
  beginAgentDeletionJournal,
  readAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  configureDeletionAgents,
  createDeletionCron,
} from "./agents-delete.fixture.test-support.js";
import { deleteGatewayAgent } from "./agents-delete.js";

it("refuses to run a pending destructive deletion through the non-destructive detach API", async () => {
  await withOpenClawTestState({ label: "agent-detach-pending-delete" }, async (state) => {
    await configureDeletionAgents(state);
    beginAgentDeletionJournal(
      {
        agentId: "doomed",
        operationId: "pending-delete",
        agentDir: state.agentDir("doomed"),
        workspaceDir: state.path("doomed"),
        sessionsDir: state.sessionsDir("doomed"),
        deleteFiles: true,
        phase: "draining",
      },
      { env: state.env },
    );
    const { context, stop } = createDeletionCron(state);
    try {
      await expect(deleteGatewayAgent("doomed", false, context, { detach: true })).rejects.toThrow(
        "has a pending deletion",
      );
      expect(readAgentDeletionJournal("doomed")).toMatchObject({
        operationId: "pending-delete",
        phase: "draining",
        deleteFiles: true,
        cleanupCompleted: false,
      });
      expect(getRuntimeConfig().agents?.entries).toHaveProperty("doomed");
    } finally {
      await stop();
    }
  });
});
