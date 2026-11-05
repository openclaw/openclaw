import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { appendPreparedTranscriptEvent } from "../config/sessions/session-transcript-event.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assertAssistantMediaPolicyCurrent,
  resolveAssistantMediaPolicy,
} from "./assistant-media-policy.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";

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

it("enforces and revokes a roleless standalone media audience, including retained tickets", () =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) => {
    const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const creator = ensureProfileForEmail("media-creator@example.test");
    const selected = ensureProfileForEmail("media-selected@example.test");
    const outsider = ensureProfileForEmail("media-outsider@example.test");
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const sessionKey = "agent:main:dashboard:confidential-media";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "confidential-media",
        updatedAt: 1,
        permissionMode: "full",
        createdActor: { type: "human", source: "profile", id: creator.id },
        access: { mode: "audience", profileIds: [selected.id] },
      },
    );
    const request = (profileId?: string) => ({
      config,
      agentId: "main",
      sessionKey,
      requestAuth: {
        authMethod: "token" as const,
        operatorScopes: ["operator.read", "operator.write"],
        ...(profileId ? { authenticatedUserProfile: gatewayProfile(profileId) } : {}),
      },
    });
    expect(await resolveAssistantMediaPolicy(request(outsider.id))).toBeUndefined();
    expect(await resolveAssistantMediaPolicy(request())).toBeUndefined();
    const params = request(selected.id);
    const policy = await resolveAssistantMediaPolicy(params);
    if (!policy) {
      throw new Error("Selected audience must receive a media policy");
    }
    try {
      assertAssistantMediaPolicyCurrent(params, policy, false, params.requestAuth);
      await applySessionEntryCanonicalReplacements({
        agentId: "main",
        storePath: database.path,
        sessionKeys: [sessionKey],
        update: (rows) => ({
          result: undefined,
          replacements: rows.map((row) => ({
            ...row,
            previousSessionKeys: [],
            accessMutation: true,
            entry: { ...row.entry, access: { mode: "creator" as const } },
          })),
        }),
      });
      expect(() =>
        assertAssistantMediaPolicyCurrent(params, policy, false, params.requestAuth),
      ).toThrow("Media access changed");
      expect(await resolveAssistantMediaPolicy(params)).toBeUndefined();
    } finally {
      policy.release();
    }
  }));
