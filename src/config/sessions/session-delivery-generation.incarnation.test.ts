import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  isSessionDeliveryGenerationRevokedError,
  prepareSessionGenerationFacts,
} from "./session-delivery-generation.js";

// Stored references follow the key through a new transcript id or a reset. Live writers
// pin the transcript; a scheduled occurrence pins its lifecycle.
it.each([
  { row: "edited", exact: undefined, current: true },
  { row: "reset", exact: undefined, current: true },
  { row: "edited", exact: "exactTranscript", current: false },
  { row: "reset", exact: "exactLifecycle", current: false },
] as const)(
  "a $row conversation is current=$current for $exact",
  async ({ row, exact, current }) => {
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
        ...(exact ? { [exact]: true as const } : {}),
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
