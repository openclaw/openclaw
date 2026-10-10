import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStore } from "./session-utils.js";

describe("sessions.patchMany orchestration", () => {
  const context = (overrides: Record<string, unknown> = {}) =>
    ({
      getRuntimeConfig: () => ({}),
      loadGatewayModelCatalog: vi.fn(async () => []),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set(),
      chatAbortControllers: new Map(),
      chatQueuedTurns: new Map(),
      dedupe: new Map(),
      ...overrides,
    }) as never;

  it("preserves request-order outcomes while isolating expected-identity failures", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:batch-${index}` },
          {
            sessionId: `session-${index}`,
            lifecycleRevision: `revision-${index}`,
            updatedAt: 1,
          },
        );
      }
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1, 2].map((index) => ({
            key: `agent:main:batch-${index}`,
            expectedSessionId: index === 1 ? "stale-session" : `session-${index}`,
            expectedLifecycleRevision: `revision-${index}`,
          })),
          patch: { unread: false },
        },
        respond,
        context: context(),
      } as never);

      const outcomes = respond.mock.calls[0]?.[1]?.outcomes;
      expect(outcomes).toEqual([
        { ok: true, key: "agent:main:batch-0" },
        {
          ok: false,
          key: "agent:main:batch-1",
          error: {
            code: "INVALID_REQUEST",
            details: { reason: "session-changed" },
            message: "Session agent:main:batch-1 changed before patch. Retry.",
          },
        },
        { ok: true, key: "agent:main:batch-2" },
      ]);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:batch-0" }),
      ).toHaveProperty("lastReadAt");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:batch-1" }),
      ).not.toHaveProperty("lastReadAt");
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:batch-2" }),
      ).toHaveProperty("lastReadAt");
    });
  });

  it("rejects logical aliases before mutation", async () => {
    const respond = vi.fn();
    await sessionMutationHandlers["sessions.patchMany"]!({
      params: {
        targets: [{ key: "agent:main:duplicate" }, { key: "duplicate" }],
        patch: { archived: true },
      },
      respond,
      context: context(),
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Duplicate target." }),
    );
  });

  it("projects non-archive patches in request order against prior successes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 2; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:label-${index}` },
          { sessionId: `session-label-${index}`, updatedAt: 1 },
        );
      }
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1].map((index) => ({ key: `agent:main:label-${index}` })),
          patch: { label: "Shared label" },
        },
        respond,
        context: context(),
      } as never);

      expect(respond.mock.calls[0]?.[1]?.outcomes).toEqual([
        { ok: true, key: "agent:main:label-0" },
        {
          ok: false,
          key: "agent:main:label-1",
          error: { code: "INVALID_REQUEST", message: "label already in use: Shared label" },
        },
      ]);
      expect(loadSessionEntry({ agentId: "main", sessionKey: "agent:main:label-0" })?.label).toBe(
        "Shared label",
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:label-1" })?.label,
      ).toBeUndefined();
    });
  });

  it("does not reserve a projected label when target authorization fails", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKeys = [0, 1].map((index) => `agent:main:label-race-${index}`);
      for (const [index, sessionKey] of sessionKeys.entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sessionId: `session-label-race-${index}`, updatedAt: 1 },
        );
      }
      const assertCurrent = vi.fn(() => {
        throw new Error("outer all-target guard must not be delegated");
      });
      const assertTargetCurrent = vi.fn(({ sessionKey }: { sessionKey: string }) => {
        if (sessionKey === sessionKeys[0]) {
          throw new SessionMutationAuthorizationChangedError({
            code: "INVALID_REQUEST",
            message: "session changed before sessions.patchMany; retry the request",
          });
        }
      });
      const respond = vi.fn();

      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: sessionKeys.map((key) => ({ key })),
          patch: { label: "Shared label" },
        },
        respond,
        context: context(),
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent },
      } as never);

      expect(assertCurrent).not.toHaveBeenCalled();
      expect([
        ...new Set(assertTargetCurrent.mock.calls.map(([target]) => target.sessionKey)),
      ]).toEqual(sessionKeys);
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            {
              ok: false,
              key: sessionKeys[0],
              error: {
                code: "INVALID_REQUEST",
                message: "session changed before sessions.patchMany; retry the request",
              },
            },
            { ok: true, key: sessionKeys[1] },
          ],
        },
        undefined,
      );
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: sessionKeys[0]! })?.label,
      ).toBeUndefined();
      expect(loadSessionEntry({ agentId: "main", sessionKey: sessionKeys[1]! })?.label).toBe(
        "Shared label",
      );
    });
  });

  it("rejects an alias conflict introduced after preflight without blocking siblings", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        session: { mainKey: "work" },
        agents: { entries: { main: {} } },
      } satisfies OpenClawConfig;
      const canonicalKey = "agent:main:work";
      const conflictingAlias = "agent:main:main";
      const siblingKeys = ["agent:main:alias-race-before", "agent:main:alias-race-after"];
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: canonicalKey },
        { sessionId: "session-alias-race-canonical", updatedAt: 1 },
      );
      for (const [index, sessionKey] of siblingKeys.entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          { sessionId: `session-alias-race-sibling-${index}`, updatedAt: 1 },
        );
      }

      const storePath = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: conflictingAlias,
      }).storePath;
      const writerStarted = createDeferredCore();
      const insertConflictingAlias = createDeferredCore();
      const writer = applySessionEntryCanonicalReplacements({
        agentId: "main",
        sessionKeys: [conflictingAlias],
        storePath,
        update: async () => {
          writerStarted.resolve();
          await insertConflictingAlias.promise;
          return {
            replacements: [
              {
                entry: { sessionId: "session-alias-race-conflict", updatedAt: 2 },
                previousSessionKeys: [],
                sessionKey: conflictingAlias,
              },
            ],
            result: undefined,
          };
        },
      });
      await writerStarted.promise;

      const preflightCompleted = createDeferredCore();
      const respond = vi.fn();
      const request = sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [{ key: siblingKeys[0]! }, { key: conflictingAlias }, { key: siblingKeys[1]! }],
          patch: { unread: false },
        },
        respond,
        context: context({
          getRuntimeConfig: () => cfg,
          workerSessionPlacementService: {
            getMany: (sessionIds: string[]) => {
              if (sessionIds.includes("session-alias-race-canonical")) {
                preflightCompleted.resolve();
              }
              return new Map();
            },
          },
        }),
      } as never);

      await preflightCompleted.promise;
      insertConflictingAlias.resolve();
      await writer;
      await request;

      expect(respond.mock.calls[0]?.[1]?.outcomes).toEqual([
        { ok: true, key: siblingKeys[0] },
        {
          ok: false,
          key: conflictingAlias,
          error: {
            code: "UNAVAILABLE",
            message: "Session patch failed unexpectedly. Retry the request.",
            retryable: true,
          },
        },
        { ok: true, key: siblingKeys[1] },
      ]);
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).toMatchObject({
        sessionId: "session-alias-race-canonical",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).not.toHaveProperty(
        "lastReadAt",
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias })).toMatchObject({
        sessionId: "session-alias-race-conflict",
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias }),
      ).not.toHaveProperty("lastReadAt");
      for (const sessionKey of siblingKeys) {
        expect(loadSessionEntry({ agentId: "main", sessionKey })).toHaveProperty("lastReadAt");
      }
    });
  });

  it("rejects an alias inserted after single-patch preflight while waiting for the writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        session: { mainKey: "work" },
        agents: { entries: { main: {} } },
      } satisfies OpenClawConfig;
      const canonicalKey = "agent:main:work";
      const conflictingAlias = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: canonicalKey },
        { sessionId: "session-single-alias-race-canonical", updatedAt: 1 },
      );

      const storePath = resolveGatewaySessionStoreTargetWithStore({
        cfg,
        key: conflictingAlias,
      }).storePath;
      const writerStarted = createDeferredCore();
      const insertConflictingAlias = createDeferredCore();
      const writer = applySessionEntryCanonicalReplacements({
        agentId: "main",
        sessionKeys: [conflictingAlias],
        storePath,
        update: async () => {
          writerStarted.resolve();
          await insertConflictingAlias.promise;
          return {
            replacements: [
              {
                entry: { sessionId: "session-single-alias-race-conflict", updatedAt: 2 },
                previousSessionKeys: [],
                sessionKey: conflictingAlias,
              },
            ],
            result: undefined,
          };
        },
      });
      await writerStarted.promise;

      const preflightCompleted = createDeferredCore();
      const respond = vi.fn();
      const request = sessionMutationHandlers["sessions.patch"]!({
        params: { key: conflictingAlias, pinned: true },
        respond,
        context: context({
          getRuntimeConfig: () => cfg,
          workerSessionPlacementService: {
            getMany: (sessionIds: string[]) => {
              if (sessionIds.includes("session-single-alias-race-canonical")) {
                preflightCompleted.resolve();
              }
              return new Map();
            },
          },
        }),
      } as never);

      await preflightCompleted.promise;
      insertConflictingAlias.resolve();
      await writer;
      await request;

      expect(respond).toHaveBeenCalledWith(false, undefined, {
        code: "UNAVAILABLE",
        message: "Session patch failed unexpectedly. Retry the request.",
        retryable: true,
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).toMatchObject({
        sessionId: "session-single-alias-race-canonical",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: canonicalKey })).not.toHaveProperty(
        "pinnedAt",
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias })).toMatchObject({
        sessionId: "session-single-alias-race-conflict",
      });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: conflictingAlias }),
      ).not.toHaveProperty("pinnedAt");
    });
  });

  it("isolates archive preparation authorization per target and continues in input order", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const targets = [0, 1, 2].map((index) => ({
        key: `agent:main:archive-auth-${index}`,
        expectedSessionId: `session-archive-auth-${index}`,
        expectedLifecycleRevision: `revision-archive-auth-${index}`,
      }));
      for (const target of targets) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: target.key },
          {
            sessionId: target.expectedSessionId,
            lifecycleRevision: target.expectedLifecycleRevision,
            updatedAt: 1,
          },
        );
      }
      const respond = vi.fn();
      const assertCurrent = vi.fn(() => {
        throw new Error("outer all-target guard must not be used");
      });
      const assertTargetCurrent = vi.fn(({ sessionKey }: { sessionKey: string }) => {
        if (sessionKey.endsWith("-1")) {
          throw new SessionMutationAuthorizationChangedError({
            code: "INVALID_REQUEST",
            message: "archive authorization changed; retry the request",
          });
        }
      });

      await sessionMutationHandlers["sessions.patchMany"]!({
        params: { targets, patch: { archived: true } },
        respond,
        context: context(),
        client: { connect: { scopes: ["operator.write"] } },
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent },
      } as never);

      expect(assertCurrent).not.toHaveBeenCalled();
      expect([
        ...new Set(assertTargetCurrent.mock.calls.map(([target]) => target.sessionKey)),
      ]).toEqual(targets.map(({ key }) => key));
      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            { ok: true, key: "agent:main:archive-auth-0" },
            {
              ok: false,
              key: "agent:main:archive-auth-1",
              error: {
                code: "INVALID_REQUEST",
                message: "archive authorization changed; retry the request",
              },
            },
            { ok: true, key: "agent:main:archive-auth-2" },
          ],
        },
        undefined,
      );
      for (const [index, target] of targets.entries()) {
        const entry = loadSessionEntry({ agentId: "main", sessionKey: target.key });
        expect(entry).toMatchObject({
          sessionId: target.expectedSessionId,
          lifecycleRevision: target.expectedLifecycleRevision,
        });
        if (index === 1) {
          expect(entry).not.toHaveProperty("archivedAt");
        } else {
          expect(entry).toHaveProperty("archivedAt");
        }
      }
    });
  });

  it("converts an unexpected target exception into an ordered isolated failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      for (let index = 0; index < 3; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:throw-${index}` },
          { sessionId: `session-throw-${index}`, updatedAt: 1 },
        );
      }
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: {
          targets: [0, 1, 2].map((index) => ({ key: `agent:main:throw-${index}` })),
          patch: { category: "Batch" },
        },
        respond,
        context: context({
          workerSessionPlacementService: {
            getMany: (sessionIds: string[]) => {
              if (sessionIds.includes("session-throw-1")) {
                throw new Error("private placement detail");
              }
              return new Map();
            },
          },
        }),
      } as never);

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          outcomes: [
            { ok: true, key: "agent:main:throw-0" },
            {
              ok: false,
              key: "agent:main:throw-1",
              error: {
                code: "UNAVAILABLE",
                message: "Session patch failed unexpectedly. Retry the request.",
                retryable: true,
              },
            },
            { ok: true, key: "agent:main:throw-2" },
          ],
        },
        undefined,
      );
    });
  });
});
