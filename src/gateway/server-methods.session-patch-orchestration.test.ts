import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { applySessionEntryCanonicalReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { sessionMutationHandlers } from "./server-methods/sessions-mutations.js";
import * as sessionPatchPreflight from "./server-methods/sessions-shared.js";
import { SessionMutationAuthorizationChangedError } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "./session-utils-store-lookup.js";

const readEntry = (sessionKey: string) => loadSessionEntry({ agentId: "main", sessionKey });
const seedEntry = (sessionKey: string, sessionId: string, lifecycleRevision?: string) =>
  upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { sessionId, updatedAt: 1, ...(lifecycleRevision ? { lifecycleRevision } : {}) },
  );

const unavailableError = {
  code: "UNAVAILABLE",
  message: "Session patch failed unexpectedly. Retry the request.",
  retryable: true,
};

async function patchMany(params: unknown) {
  const respond = vi.fn();
  await sessionMutationHandlers["sessions.patchMany"]!({
    params,
    respond,
    context: patchContext(),
  } as never);
  return respond;
}

const success = (key: string) => ({ ok: true, key });
const failure = (key: string, error: unknown) => ({ ok: false, key, error });
const expectOutcomes = (respond: ReturnType<typeof vi.fn>, outcomes: unknown[]) =>
  expect(respond.mock.calls[0]).toEqual([true, { outcomes }, undefined]);

async function checkAliasConflict(batch: boolean, signal: AbortSignal) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const prefix = batch ? "session-alias-race" : "session-single-alias-race";
    const siblings = batch ? ["agent:main:alias-race-before", "agent:main:alias-race-after"] : [];
    const cfg = {
      session: { mainKey: "work" },
      agents: { entries: { main: {} } },
    } satisfies OpenClawConfig;
    setRuntimeConfigSnapshot(cfg);
    const canonicalKey = "agent:main:work";
    const conflictingAlias = "agent:main:main";
    await seedEntry(canonicalKey, `${prefix}-canonical`);
    for (const [index, sessionKey] of siblings.entries()) {
      await seedEntry(sessionKey, `session-alias-race-sibling-${index}`);
    }
    const { storePath } = await resolveGatewaySessionStoreTargetWithStoreAsync({
      cfg,
      key: conflictingAlias,
    });
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
              entry: { sessionId: `${prefix}-conflict`, updatedAt: 2 },
              previousSessionKeys: [],
              sessionKey: conflictingAlias,
            },
          ],
          result: undefined,
        };
      },
    });
    await withinTest(
      awaitGateBeforeSettlement(writerStarted.promise, writer, "Writer skipped preparation"),
      signal,
    );
    const preflightCompleted = createDeferredCore();
    const preparePlacementValidation =
      sessionPatchPreflight.prepareSessionWorkerPlacementPatchValidation;
    using _ = vi
      .spyOn(sessionPatchPreflight, "prepareSessionWorkerPlacementPatchValidation")
      .mockImplementation(async (params) => {
        const validation = await preparePlacementValidation(params);
        if (params.entry?.sessionId === `${prefix}-canonical`) {
          preflightCompleted.resolve();
        }
        return validation;
      });
    const respond = vi.fn();
    const request = sessionMutationHandlers[batch ? "sessions.patchMany" : "sessions.patch"]!({
      params: batch
        ? {
            targets: [{ key: siblings[0]! }, { key: conflictingAlias }, { key: siblings[1]! }],
            patch: { unread: false },
          }
        : { key: conflictingAlias, pinned: true },
      respond,
      context: patchContext({ getRuntimeConfig: () => cfg }),
    } as never);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          preflightCompleted.promise,
          Promise.resolve(request),
          "Patch settled before preparing its target",
        ),
        signal,
      );
    } finally {
      insertConflictingAlias.resolve();
      await Promise.allSettled([writer, request]);
    }
    await writer;
    await request;
    if (batch) {
      expectOutcomes(respond, [
        { ok: true, key: siblings[0] },
        { ok: false, key: conflictingAlias, error: unavailableError },
        { ok: true, key: siblings[1] },
      ]);
    } else {
      expect(respond).toHaveBeenCalledWith(false, undefined, unavailableError);
    }
    const unchangedField = batch ? "lastReadAt" : "pinnedAt";
    expect(readEntry(canonicalKey)).toMatchObject({ sessionId: `${prefix}-canonical` });
    expect(readEntry(canonicalKey)).not.toHaveProperty(unchangedField);
    expect(readEntry(conflictingAlias)).toMatchObject({ sessionId: `${prefix}-conflict` });
    expect(readEntry(conflictingAlias)).not.toHaveProperty(unchangedField);
    for (const key of siblings) {
      expect(readEntry(key)).toHaveProperty("lastReadAt");
    }
  });
}

const patchContext = (overrides: Record<string, unknown> = {}) =>
  ({
    getRuntimeConfig: () => ({}),
    loadGatewayModelCatalog: vi.fn(async () => []),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    dedupe: new Map(),
    ...overrides,
  }) as never;

describe("sessions.patchMany orchestration", () => {
  it("preserves request-order outcomes while isolating expected-identity failures", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      for (let index = 0; index < 3; index += 1) {
        await seedEntry(`agent:main:batch-${index}`, `session-${index}`, `revision-${index}`);
      }
      const respond = await patchMany({
        targets: [0, 1, 2].map((index) => ({
          key: `agent:main:batch-${index}`,
          expectedSessionId: index === 1 ? "stale-session" : `session-${index}`,
          expectedLifecycleRevision: `revision-${index}`,
        })),
        patch: { unread: false },
      });

      expectOutcomes(respond, [
        success("agent:main:batch-0"),
        failure("agent:main:batch-1", {
          code: "INVALID_REQUEST",
          details: { reason: "session-changed" },
          message: "Session agent:main:batch-1 changed before patch. Retry.",
        }),
        success("agent:main:batch-2"),
      ]);
      expect(readEntry("agent:main:batch-0")).toHaveProperty("lastReadAt");
      expect(readEntry("agent:main:batch-1")).not.toHaveProperty("lastReadAt");
      expect(readEntry("agent:main:batch-2")).toHaveProperty("lastReadAt");
    });
  });

  it("rejects logical aliases before mutation", async () => {
    const respond = await patchMany({
      targets: [{ key: "agent:main:duplicate" }, { key: "duplicate" }],
      patch: { archived: true },
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "Duplicate target." }),
    );
  });

  it.each([
    { archived: false, name: "does not reserve a projected label when target authorization fails" },
    {
      archived: true,
      name: "isolates archive preparation authorization per target in input order",
    },
  ])("$name", async ({ archived }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const prefix = archived ? "archive-auth" : "label-race";
      const failedIndex = archived ? 1 : 0;
      const message = archived
        ? "archive authorization changed; retry the request"
        : "session changed before sessions.patchMany; retry the request";
      const targets = Array.from({ length: archived ? 3 : 2 }, (_, index) => ({
        key: `agent:main:${prefix}-${index}`,
        ...(archived
          ? {
              expectedSessionId: `session-${prefix}-${index}`,
              expectedLifecycleRevision: `revision-${prefix}-${index}`,
            }
          : {}),
      }));
      for (const [index, target] of targets.entries()) {
        await seedEntry(target.key, `session-${prefix}-${index}`, target.expectedLifecycleRevision);
      }
      const assertCurrent = vi.fn(() => {
        throw new Error("outer all-target guard must not be used");
      });
      const assertTargetCurrent = vi.fn(({ sessionKey }: { sessionKey: string }) => {
        if (sessionKey === targets[failedIndex]!.key) {
          throw new SessionMutationAuthorizationChangedError({ code: "INVALID_REQUEST", message });
        }
      });
      const respond = vi.fn();
      await sessionMutationHandlers["sessions.patchMany"]!({
        params: { targets, patch: archived ? { archived: true } : { label: "Shared label" } },
        respond,
        context: patchContext(),
        ...(archived ? { client: { connect: { scopes: ["operator.write"] } } } : {}),
        sessionMutationAuthorization: { assertCurrent, assertTargetCurrent },
      } as never);
      expect(assertCurrent).not.toHaveBeenCalled();
      const checkedKeys = new Set(
        assertTargetCurrent.mock.calls.map(([target]) => target.sessionKey),
      );
      const keys = targets.map(({ key }) => key);
      if (archived) {
        expect(checkedKeys).toEqual(new Set(keys));
      } else {
        expect([...checkedKeys]).toEqual(keys);
      }
      expectOutcomes(
        respond,
        keys.map((key, index) =>
          index === failedIndex ? failure(key, { code: "INVALID_REQUEST", message }) : success(key),
        ),
      );
      for (const [index, target] of targets.entries()) {
        const entry = readEntry(target.key);
        if (archived) {
          expect(entry).toMatchObject({
            sessionId: target.expectedSessionId,
            lifecycleRevision: target.expectedLifecycleRevision,
          });
          if (index === failedIndex) {
            expect(entry).not.toHaveProperty("archivedAt");
          } else {
            expect(entry).toHaveProperty("archivedAt");
          }
        } else {
          expect(entry?.label).toBe(index === failedIndex ? undefined : "Shared label");
        }
      }
    });
  });

  it("rejects an alias conflict introduced after preflight without blocking siblings", async ({
    signal,
  }) => {
    await checkAliasConflict(true, signal);
  });

  it("rejects an alias inserted after single-patch preflight while waiting for the writer", async ({
    signal,
  }) => {
    await checkAliasConflict(false, signal);
  });

  it("converts an unexpected target exception into an ordered isolated failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      for (let index = 0; index < 3; index += 1) {
        await seedEntry(`agent:main:throw-${index}`, `session-throw-${index}`);
      }
      const preparePlacementValidation =
        sessionPatchPreflight.prepareSessionWorkerPlacementPatchValidation;
      using _ = vi
        .spyOn(sessionPatchPreflight, "prepareSessionWorkerPlacementPatchValidation")
        .mockImplementation(async (params) => {
          if (params.entry?.sessionId === "session-throw-1") {
            throw new Error("private placement detail");
          }
          return preparePlacementValidation(params);
        });
      const respond = await patchMany({
        targets: [0, 1, 2].map((index) => ({ key: `agent:main:throw-${index}` })),
        patch: { category: "Batch" },
      });

      expectOutcomes(respond, [
        success("agent:main:throw-0"),
        failure("agent:main:throw-1", unavailableError),
        success("agent:main:throw-2"),
      ]);
    });
  });
});
