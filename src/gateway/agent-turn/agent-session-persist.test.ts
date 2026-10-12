import { describe, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentSessionPatchBuild } from "../server-methods/agent-session-patch.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";

describe("persistAgentSessionPhase", () => {
  it("sandboxes a new synthetic run using its host-minted operator identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const profile = ensureProfileForEmail("synthetic-sandbox-creator@example.com");
      const sessionKey = "agent:main:synthetic-sandbox";
      const runId = "synthetic-sandbox-run";
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const patchBuild: AgentSessionPatchBuild = {
        patch: { sessionId: runId, updatedAt: 1 },
        spawnedBy: undefined,
        groupId: undefined,
        groupChannel: undefined,
        groupSpace: undefined,
        freshSessionRotatedSinceLoad: false,
        isNewSession: true,
        rotatedSessionId: false,
        usableRequestedSessionId: undefined,
        freshness: undefined,
      };

      const sql = observeHostDataSql();
      const committed = vi.fn((entry: { sessionId: string }) => {
        sql.restore();
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.sessionId).toBe(
          entry.sessionId,
        );
      });
      const result = await persistAgentSessionPhase({
        onSessionCommitted: committed,
        request: { message: "sandboxed", idempotencyKey: runId },
        cfg: {
          gateway: {
            roles: {
              default: "guest",
              definitions: {
                guest: {
                  sessions: { others: "view" },
                  agents: ["main"],
                  scopes: ["operator.write"],
                  sandbox: "required",
                },
              },
            },
          },
        },
        storePath,
        canonicalSessionKey: sessionKey,
        sessionAgentId: "main",
        mainSessionKey: "agent:main:main",
        creation: { via: "run" },
        operatorRoleActor: { kind: "operator", profileId: profile.id },
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        isRestartRecoveryResumeRun: false,
        runId,
        agentId: "main",
        suppressVisibleSessionEffects: false,
        initialPatchBuild: patchBuild,
        buildSessionPatch: async () => patchBuild,
        state: {
          sessionPersistedBeforeGatewayAdmission: false,
          admittedSessionId: runId,
          skipAgentInitialSessionTouch: false,
          isNewSession: true,
          bestEffortDeliver: false,
        },
        touchInteraction: false,
        expectedSession: undefined,
        maintenanceConfig: undefined,
        abortForLifecycleRotation: () => false,
        assertGatewayWorkAdmissionAllowed: vi.fn(),
        respondToGatewayAdmissionOutcome: () => false,
        setCronContinuationClaim: vi.fn(),
        setMainRestartRecoveryOwnerLease: vi.fn(),
        respond: vi.fn(),
      }).finally(sql.restore);

      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      expect(result?.sessionEntry).toMatchObject({
        createdVia: "run",
        createdActor: { type: "human", id: profile.id },
        sandbox: "required",
      });
      expect(committed).toHaveBeenCalledOnce();
      expect(committed.mock.calls[0]?.[0].sessionId).toBe(result?.sessionEntry?.sessionId);
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        sandbox: "required",
      });
    });
  });

  it.each([false, true])(
    "surfaces creation denial before lifecycle rotation (revoked during preparation: %s)",
    async (revokeDuringPreparation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const sessionKey = "agent:main:role-denied";
        const runId = "role-denied-run";
        const profile = ensureProfileForEmail("role-denied-creator@example.com");
        const allowedAgents = revokeDuringPreparation ? ["main"] : [];
        const respond = vi.fn<Parameters<typeof persistAgentSessionPhase>[0]["respond"]>();
        const abortForLifecycleRotation = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
        const patchBuild: AgentSessionPatchBuild = {
          patch: { sessionId: runId, updatedAt: 1 },
          spawnedBy: undefined,
          groupId: undefined,
          groupChannel: undefined,
          groupSpace: undefined,
          freshSessionRotatedSinceLoad: false,
          isNewSession: true,
          rotatedSessionId: false,
          usableRequestedSessionId: undefined,
          freshness: undefined,
        };

        await expect(
          persistAgentSessionPhase({
            request: { message: "denied", idempotencyKey: runId },
            cfg: {
              gateway: {
                roles: {
                  default: "restricted",
                  definitions: {
                    restricted: { sessions: { others: "none" }, agents: allowedAgents, scopes: [] },
                  },
                },
              },
            },
            storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
            canonicalSessionKey: sessionKey,
            sessionAgentId: "main",
            mainSessionKey: "agent:main:main",
            creation: { via: "run" },
            operatorRoleActor: { kind: "operator", profileId: profile.id },
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            isRestartRecoveryResumeRun: false,
            runId,
            agentId: "main",
            suppressVisibleSessionEffects: false,
            initialPatchBuild: patchBuild,
            buildSessionPatch: async () => {
              await Promise.resolve();
              allowedAgents.length = 0;
              return patchBuild;
            },
            state: {
              sessionPersistedBeforeGatewayAdmission: false,
              admittedSessionId: runId,
              skipAgentInitialSessionTouch: false,
              isNewSession: true,
              bestEffortDeliver: false,
            },
            touchInteraction: false,
            expectedSession: undefined,
            maintenanceConfig: undefined,
            abortForLifecycleRotation,
            assertGatewayWorkAdmissionAllowed: vi.fn(),
            respondToGatewayAdmissionOutcome: () => false,
            setCronContinuationClaim: vi.fn(),
            setMainRestartRecoveryOwnerLease: vi.fn(),
            respond,
          }),
        ).resolves.toBeUndefined();

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            message: expect.stringContaining('agent "main"'),
          }),
        );
        expect(abortForLifecycleRotation).toHaveBeenCalledTimes(1);
      });
    },
  );
});
