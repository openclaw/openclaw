import { describe, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentSessionPatchBuild } from "../server-methods/agent-session-patch.js";
import { withSessionSendDelivery } from "../session-send-delivery.js";
import { persistAgentSessionPhase } from "./agent-session-persist.js";

const profileState = { scenario: "minimal", prepareProfileCatalog: true } as const;
type PersistParams = Parameters<typeof persistAgentSessionPhase>[0];

function makePersistParams(
  overrides: Pick<PersistParams, "runId" | "canonicalSessionKey" | "storePath" | "cfg"> &
    Partial<PersistParams>,
): PersistParams {
  const { runId } = overrides;
  const initialPatchBuild: AgentSessionPatchBuild = {
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
  return {
    request: { message: "sandboxed", idempotencyKey: runId },
    sessionAgentId: "main",
    mainSessionKey: "agent:main:main",
    creation: { via: "run" },
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    isRestartRecoveryResumeRun: false,
    agentId: "main",
    suppressVisibleSessionEffects: false,
    initialPatchBuild,
    buildSessionPatch: async () => initialPatchBuild,
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
    assertGatewayWorkAdmissionAllowed: vi.fn(),
    respondToGatewayAdmissionOutcome: () => false,
    setCronContinuationClaim: vi.fn(),
    setMainRestartRecoveryOwnerLease: vi.fn(),
    respond: vi.fn(),
    ...overrides,
  };
}

describe("persistAgentSessionPhase", () => {
  it.each([false, true])(
    "sandboxes a synthetic run and preserves interrupted recovery ownership (queued peer: %s)",
    async (queuedPeer) => {
      await withOpenClawTestState(profileState, async (state) => {
        const profile = ensureProfileForEmail("synthetic-sandbox-creator@example.com");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const sessionKey = "agent:main:synthetic-sandbox";
        const runId = "synthetic-sandbox-run";
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        const sql = observeHostDataSql();
        const committed = vi.fn((entry: { sessionId: string }) => {
          sql.restore();
          expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.sessionId).toBe(
            entry.sessionId,
          );
        });
        const setMainRestartRecoveryOwnerLease = vi.fn();
        const params = makePersistParams({
          onSessionCommitted: committed,
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
          operatorRoleActor: { kind: "operator", profileId: profile.id },
          runId,
          setMainRestartRecoveryOwnerLease,
        });
        const result = await persistAgentSessionPhase(params).finally(sql.restore);

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

        if (!result?.sessionEntry) {
          throw new Error("Fixture requires a persisted session");
        }
        const interruptedRun = {
          runId: "interrupted-before-send",
          lifecycleGeneration: "previous-generation",
        };
        const interrupted = {
          ...result.sessionEntry,
          abortedLastRun: true,
          restartRecoveryRuns: [interruptedRun],
        };
        await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, interrupted);
        const resumedPatch = { ...params.initialPatchBuild, isNewSession: false };
        const persist = () =>
          persistAgentSessionPhase({
            ...params,
            onSessionCommitted: undefined,
            entry: interrupted,
            initialPatchBuild: resumedPatch,
            buildSessionPatch: async () => resumedPatch,
            state: { ...result, sessionEntry: interrupted, isNewSession: false },
          });
        if (queuedPeer) {
          await withSessionSendDelivery(
            {
              delivery: {
                version: 1,
                runId,
                source: {
                  agentId: "main",
                  sessionKey: "agent:main:sender",
                  sessionId: "sender-session",
                },
                target: { agentId: "main", sessionKey, sessionId: interrupted.sessionId },
                sandboxed: true,
                message: "sandboxed",
              },
            },
            persist,
          );
        } else {
          await persist();
        }
        const current = loadSessionEntry({ agentId: "main", sessionKey, storePath });
        expect(current?.restartRecoveryRuns).toContainEqual(interruptedRun);
        if (queuedPeer) {
          expect(current?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
          expect(current?.restartRecoveryRuns).toEqual([interruptedRun]);
          expect(setMainRestartRecoveryOwnerLease).not.toHaveBeenCalled();
        } else {
          expect(
            Object.values(current?.mainRestartRecovery?.foregroundClaims?.runIdsByClaimId ?? {}),
          ).toContain(runId);
          expect(setMainRestartRecoveryOwnerLease).toHaveBeenCalledOnce();
        }
      });
    },
  );

  it.each([false, true])(
    "surfaces creation denial when role authority forbids the agent (revoked during preparation: %s)",
    async (revokeDuringPreparation) => {
      await withOpenClawTestState(profileState, async (state) => {
        const sessionKey = "agent:main:role-denied";
        const runId = "role-denied-run";
        const profile = ensureProfileForEmail("role-denied-creator@example.com");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const allowedAgents = revokeDuringPreparation ? ["main"] : [];
        const respond = vi.fn<Parameters<typeof persistAgentSessionPhase>[0]["respond"]>();
        const params = makePersistParams({
          request: { message: "denied", idempotencyKey: runId },
          cfg: {
            gateway: {
              roles: {
                default: "restricted",
                definitions: {
                  restricted: {
                    sessions: { others: "none" },
                    agents: allowedAgents,
                    scopes: [],
                  },
                },
              },
            },
          },
          storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
          canonicalSessionKey: sessionKey,
          operatorRoleActor: { kind: "operator", profileId: profile.id },
          runId,
          respond,
        });
        params.buildSessionPatch = async () => {
          await Promise.resolve();
          allowedAgents.length = 0;
          return params.initialPatchBuild;
        };
        await expect(persistAgentSessionPhase(params)).resolves.toBeUndefined();

        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "FORBIDDEN",
            message: expect.stringContaining('agent "main"'),
          }),
        );
      });
    },
  );
});
