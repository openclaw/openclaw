import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  isSessionDeliveryGenerationRevokedError,
  prepareSessionGenerationFacts,
} from "./session-delivery-generation.js";

// A message edit or branch switch rotates the session id inside one incarnation; a reset
// rotates the lifecycle revision. Stored references follow the first; live writers do not.
it.each([
  { row: "edited", exactTranscript: undefined, current: true },
  { row: "reset", exactTranscript: undefined, current: false },
  { row: "edited", exactTranscript: true, current: false },
] as const)(
  "a $row conversation is current=$current for exactTranscript=$exactTranscript",
  async ({ row, exactTranscript, current }) => {
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
        lifecycleRevision: "original",
        ...(exactTranscript ? { exactTranscript } : {}),
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
