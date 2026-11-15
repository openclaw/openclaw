import { expect, it } from "vitest";
import { registerOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionGenerationFacts } from "./session-delivery-generation.js";

it.each([
  ...(["same", "unrelated"] as const).map((change) => ({
    change,
    location: "shared",
  })),
  ...(["same", "unrelated"] as const).map((change) => ({
    change,
    location: "canonical",
  })),
])(
  "retains only unchanged $location sharing sources after a $change registry publication",
  async ({ change, location }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const canonical = location === "canonical";
      const storePath = canonical
        ? resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
        : state.statePath("shared.sqlite");
      const registration = { agentId: "main", path: storePath, env: state.env };
      openOpenClawAgentDatabase(registration);
      const agentId = canonical ? "main" : "ops";
      const target = { agentId, sessionKey: `agent:${agentId}:registry-sharing` };
      replaceSessionEntrySync(
        { ...target, storePath },
        { sessionId: "registry-sharing", lifecycleRevision: "first", updatedAt: 1 },
      );
      const prepared = await prepareSessionGenerationFacts({
        ...target,
        storePath,
        sessionId: "registry-sharing",
        lifecycleRevision: "first",
      });
      try {
        if (change === "unrelated") {
          openOpenClawAgentDatabase({ agentId: "neighbor", env: state.env });
        } else {
          registerOpenClawAgentDatabase(registration);
        }
        prepared.assertCurrent();
        expect(prepared.prepareRead()).toBeUndefined();
      } finally {
        prepared.release();
      }
    });
  },
);
