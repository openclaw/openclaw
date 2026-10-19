import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendPreparedTranscriptEvent } from "../config/sessions/session-transcript-event.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertAssistantMediaPolicyCurrent,
  resolveAssistantMediaPolicy,
} from "./assistant-media-policy.js";

// mock-isolation: The core test worker cannot host the unrelated placement broker.
vi.mock("./session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: () => new Map(),
      getManyAsync: async () => new Map(),
    },
  }),
}));

it.each(["transcript-only write", "permission narrowing", "owner retirement"] as const)(
  "retains the current media policy through %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:media-policy",
        sessionId: "media-policy-session",
        env: state.env,
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        permissionMode: "full",
      });
      const params = {
        config,
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        requestAuth: {
          authMethod: "token" as const,
          operatorScopes: ["operator.admin", "operator.read"],
        },
      };
      const policy = await resolveAssistantMediaPolicy(params);
      expect(policy).toBeDefined();
      if (!policy) {
        throw new Error("Expected admitted media policy");
      }
      try {
        assertAssistantMediaPolicyCurrent(params, policy, false, params.requestAuth);
        if (change === "transcript-only write") {
          expect(
            await appendPreparedTranscriptEvent(
              scope,
              { type: "proof", id: "media-policy-event" },
              () => {},
            ),
          ).toBe(true);
          expect(() =>
            assertAssistantMediaPolicyCurrent(params, policy, false, params.requestAuth),
          ).not.toThrow();
        } else {
          if (change === "permission narrowing") {
            await patchSessionEntryCore(scope, () => ({ permissionMode: "workspace" }), {
              requireWriteSuccess: true,
            });
          } else {
            await closeOpenClawAgentDatabaseByPathAsync(database.path);
          }
          expect(() =>
            assertAssistantMediaPolicyCurrent(params, policy, false, params.requestAuth),
          ).toThrow("Media access changed");
        }
      } finally {
        policy.release();
      }
    });
  },
);
