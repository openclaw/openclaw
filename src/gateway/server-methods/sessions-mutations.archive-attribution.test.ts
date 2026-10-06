import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

function client(profileId?: string, displayName?: string): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    ...(profileId
      ? {
          authenticatedUserId: `${profileId}@example.com`,
          authenticatedUserProfile: {
            profileId,
            displayName: displayName ?? null,
            hasAvatar: false,
            updatedAt: 1,
          },
        }
      : {}),
  };
}

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({ entries: [], routeVariants: [] })),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

async function patchSession(
  params: { key: string; archived: boolean; expectedSessionId: string; label?: string },
  requestClient: GatewayClient,
) {
  const responses = await invokePatchSession(params, requestClient);
  expect(responses).toHaveLength(1);
  expect(responses[0]?.[0]).toBe(true);
}

async function invokePatchSession(
  params: { key: string; archived: boolean; expectedSessionId: string; label?: string },
  requestClient: GatewayClient,
) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: requestClient,
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}

describe("sessions.patch archive attribution", () => {
  it.each([undefined, 20])(
    "settles restart residue and preserves receipts and the first archiver (endedAt=%s)",
    async (endedAt) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionKey = "agent:main:archive-attribution";
        const sessionId = "session-archive-attribution";
        const retained = {
          mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
          restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "previous-boot" }],
          restartRecoveryTerminalRunIds: ["delivered-run"],
          pendingFinalDelivery: {
            kind: "replayable" as const,
            text: "Retained final",
            createdAt: 15,
          },
          lastRunId: "previous-terminal-client-run",
          ...(endedAt === undefined ? {} : { endedAt, runtimeMs: 10 }),
        };
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 1,
            pinnedAt: 2,
            status: "running",
            startedAt: 10,
            abortedLastRun: true,
            lifecycleRunId: "interrupted-run",
            ...retained,
          },
        );

        await patchSession(
          { key: sessionKey, archived: true, expectedSessionId: sessionId },
          client("profile-ada", "Ada"),
        );
        expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
          ...retained,
          status: "killed",
          abortedLastRun: true,
          endedAt: endedAt ?? expect.any(Number),
          archivedAt: expect.any(Number),
          archivedBy: { type: "human", id: "profile-ada", label: "Ada" },
        });
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.lifecycleRunId).toBeUndefined();
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.runtimeMs).toBe(
          endedAt === undefined ? undefined : 10,
        );

        await patchSession(
          { key: sessionKey, archived: true, expectedSessionId: sessionId },
          client("profile-bob", "Bob"),
        );
        expect(loadSessionEntry({ agentId: "main", sessionKey })?.archivedBy).toEqual({
          type: "human",
          id: "profile-ada",
          label: "Ada",
        });

        await patchSession(
          { key: sessionKey, archived: false, expectedSessionId: sessionId },
          client("profile-bob", "Bob"),
        );
        const restored = loadSessionEntry({ agentId: "main", sessionKey });
        expect(restored?.archivedAt).toBeUndefined();
        expect(restored?.archivedBy).toBeUndefined();
        expect(restored).toMatchObject({ ...retained, status: "killed" });

        expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
      });
    },
  );

  it("does not fabricate attribution or transcript events for an unidentified client", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:solo-archive";
      const sessionId = "session-solo-archive";
      const terminal = {
        status: "failed" as const,
        startedAt: 10,
        endedAt: 20,
        runtimeMs: 10,
        abortedLastRun: false,
        lastRunId: "failed-run",
        lastRunError: "Execution failed",
      };
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1, ...terminal },
      );

      await patchSession(
        { key: sessionKey, archived: true, expectedSessionId: sessionId },
        client(),
      );

      const archived = loadSessionEntry({ agentId: "main", sessionKey });
      expect(archived).toMatchObject(terminal);
      expect(archived?.archivedAt).toEqual(expect.any(Number));
      expect(archived?.archivedBy).toBeUndefined();
      expect(await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey })).toEqual([]);
    });
  });

  it("archives through an alias with attribution", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const canonicalKey = "agent:main:alias-happy-archive";
      const aliasKey = "alias-happy-archive";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: canonicalKey },
        {
          sessionId: "session-canonical-happy-archive",
          updatedAt: 1,
        },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: aliasKey },
        { sessionId: "session-alias-happy-archive", updatedAt: 2 },
      );

      const projection = await createSessionRowProjection({ cfg: {} });
      try {
        await patchSession(
          {
            key: aliasKey,
            archived: true,
            expectedSessionId: "session-alias-happy-archive",
          },
          client("profile-ada", "Ada"),
        );
        const query = { key: canonicalKey, agentId: "main" };
        await withReadySessionRows(
          projection,
          () => [query],
          () => {
            expect(projection.snapshot(query).row).toMatchObject({
              archived: true,
              archivedAt: expect.any(Number),
              archivedBy: { type: "human", id: "profile-ada" },
            });
          },
        );
      } finally {
        projection.dispose();
      }
    });
  });
});
