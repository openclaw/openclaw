import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  isSessionDeliveryGenerationRevokedError,
  prepareSessionGenerationFacts,
} from "./session-delivery-generation.js";

it.each([
  { row: "edited", followConversation: true, revision: "original", current: true },
  { row: "reset", followConversation: true, revision: "original", current: false },
  { row: "reset", followConversation: true, revision: null, current: true },
  { row: "edited", followConversation: undefined, revision: "original", current: false },
  { row: "reset", followConversation: undefined, revision: "original", current: false },
] as const)(
  "$row conversation current=$current for followConversation=$followConversation revision=$revision",
  async ({ row, followConversation, revision, current }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      openOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
      const target = { agentId: "main", sessionKey: "agent:main:dashboard:edited", storePath };
      replaceSessionEntrySync(target, {
        sessionId: row === "edited" ? "edited-session" : "original-session",
        lifecycleRevision: row === "edited" ? "original" : "reset",
        updatedAt: 1,
      });
      const prepared = prepareSessionGenerationFacts({
        ...target,
        sessionId: "original-session",
        lifecycleRevision: revision,
        ...(followConversation ? { followConversation } : {}),
      });
      if (!current) {
        await expect(prepared).rejects.toSatisfy(isSessionDeliveryGenerationRevokedError);
        return;
      }
      const lease = await prepared;
      try {
        expect(() => lease.assertCurrent()).not.toThrow();
      } finally {
        lease.release();
      }
    });
  },
);
