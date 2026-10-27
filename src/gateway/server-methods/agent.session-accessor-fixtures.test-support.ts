import { vi, type Mock } from "vitest";
import type {
  SessionTranscriptReadScope,
  recordSessionParticipant,
  listSessionParticipantsReadOnly,
} from "../../config/sessions/session-accessor.js";
import type { ResetSessionEntryLifecycleMutation } from "../../config/sessions/session-accessor.lifecycle-types.js";
import type { resetSessionEntryLifecycle } from "../../config/sessions/session-accessor.lifecycle.js";
import type { stageSessionPendingInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import type { readTranscriptMutationStateInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentTestStorePath } from "./agent.user-turn-recorder.test-support.js";

type SessionStoreFixture = Record<string, Record<string, unknown>>;

type SessionEntryTargetFixture = {
  canonicalKey: string;
  storeKeys: string[];
};

function cloneSessionStoreFixtureEntry(
  entry: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return entry ? structuredClone(entry) : undefined;
}

function selectFreshestTargetFixtureEntry(
  store: SessionStoreFixture,
  target: SessionEntryTargetFixture,
): { entry: Record<string, unknown>; key: string } | undefined {
  let freshest: { entry: Record<string, unknown>; key: string } | undefined;
  for (const key of new Set([target.canonicalKey, ...target.storeKeys])) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    if (
      !freshest ||
      ((entry.updatedAt as number | undefined) ?? 0) >
        ((freshest.entry.updatedAt as number | undefined) ?? 0)
    ) {
      freshest = { entry, key };
    }
  }
  return freshest;
}

type SessionAccessorMocks = {
  stageSessionPendingInput: Mock<typeof stageSessionPendingInput>;
  recordSessionParticipant: Mock<typeof recordSessionParticipant>;
  listSessionParticipantsReadOnly: Mock<typeof listSessionParticipantsReadOnly>;
  hasSessionTranscriptEventsSync: Mock<(scope: SessionTranscriptReadScope) => boolean>;
  readTranscriptMutationStateSync: Mock<
    (
      scope: SessionTranscriptReadScope,
    ) => ReturnType<typeof readTranscriptMutationStateInTransaction>
  >;
  applySessionEntryReplacements: Mock;
  persistSessionTranscriptTurn: Mock;
  resetSessionEntryLifecycle: Mock<typeof resetSessionEntryLifecycle>;
  patchSessionEntryTarget: Mock;
  updateSessionStore: Mock;
};

export function createSessionAccessorMockReset(mocks: SessionAccessorMocks) {
  return () => {
    // These handler fixtures own an in-memory store. Real admission durability
    // and execution-time promotion are covered by the gateway-server suites.
    mocks.stageSessionPendingInput.mockReset().mockImplementation(async (_scope, options) => {
      options.assertCurrent();
      const message = options.prepareMessageAfterIdempotencyCheck
        ? options.prepareMessageAfterIdempotencyCheck(options.message)
        : options.message;
      return message
        ? {
            state: "queued",
            inputId: "test-user-turn",
            message,
            run: (operation) => operation(),
            finish: vi.fn(),
          }
        : undefined;
    });
    mocks.recordSessionParticipant.mockReset().mockResolvedValue("inserted");
    mocks.listSessionParticipantsReadOnly.mockReset().mockReturnValue(new Map());
    mocks.hasSessionTranscriptEventsSync.mockReset().mockReturnValue(false);
    mocks.readTranscriptMutationStateSync.mockReset().mockReturnValue({
      observedAt: null,
      updatedAt: null,
    });
    mocks.applySessionEntryReplacements.mockReset().mockImplementation(
      async (params: {
        activeSessionKey?: string;
        requireWriteSuccess?: boolean;
        sessionKeys?: readonly string[];
        skipMaintenance?: boolean;
        storePath: string;
        update: (entries: Array<{ sessionKey: string; entry: SessionEntry }>) =>
          | Promise<{
              replacements?: Iterable<{ sessionKey: string; entry: SessionEntry }>;
              result: unknown;
            }>
          | {
              replacements?: Iterable<{ sessionKey: string; entry: SessionEntry }>;
              result: unknown;
            };
      }) => {
        let updateResult: Promise<unknown> | undefined;
        await mocks.updateSessionStore(
          params.storePath,
          (store: Record<string, SessionEntry>) => {
            updateResult = (async () => {
              const keys = params.sessionKeys ?? Object.keys(store);
              const snapshots = keys.flatMap((sessionKey) => {
                const entry = store[sessionKey];
                return entry ? [{ sessionKey, entry: structuredClone(entry) }] : [];
              });
              const planned = await params.update(snapshots);
              for (const replacement of planned.replacements ?? []) {
                if (store[replacement.sessionKey]) {
                  store[replacement.sessionKey] = structuredClone(replacement.entry);
                }
              }
              return planned.result;
            })();
            return updateResult;
          },
          {
            activeSessionKey: params.activeSessionKey,
            requireWriteSuccess: params.requireWriteSuccess,
            skipMaintenance: params.skipMaintenance,
          },
        );
        // Empty store stubs must still run the projection; undefined can be its valid result.
        return updateResult === undefined ? (await params.update([])).result : await updateResult;
      },
    );
    mocks.persistSessionTranscriptTurn.mockReset().mockImplementation(
      async (
        scope: {
          agentId?: string;
          sessionId: string;
          sessionKey: string;
          sessionEntry?: SessionEntry;
          storePath?: string;
        },
        options: {
          messages: Array<{
            message: unknown;
            prepareMessageAfterIdempotencyCheck?: (message: unknown) => unknown;
          }>;
        },
      ) => {
        const candidate = options.messages[0]?.message;
        const message =
          options.messages[0]?.prepareMessageAfterIdempotencyCheck?.(candidate) ?? candidate;
        if (!message) {
          return { messages: [], sessionEntry: scope.sessionEntry };
        }
        return {
          messages: [
            {
              appended: true,
              messageId: "test-user-turn",
              message,
              anchor: {
                agentId: scope.agentId ?? "main",
                sessionId: scope.sessionId,
                sessionKey: scope.sessionKey,
                storePath: scope.storePath ?? getAgentTestStorePath(),
                generation: "test-generation",
                entryId: "test-user-turn",
                rawSeq: 1,
                effectiveParentId: null,
                activeMessagePosition: 0,
              },
            },
          ],
          sessionEntry: scope.sessionEntry,
        };
      },
    );
    mocks.resetSessionEntryLifecycle.mockReset().mockImplementation(async (params) => {
      let mutation: ResetSessionEntryLifecycleMutation | undefined;
      await mocks.updateSessionStore(
        params.storePath,
        async (store: Record<string, SessionEntry>) => {
          params.commitGuard?.();
          const previousEntry = store[params.target.canonicalKey];
          const nextEntry = await params.buildNextEntry({
            currentEntry: previousEntry ? structuredClone(previousEntry) : undefined,
            primaryKey: params.target.canonicalKey,
          });
          params.commitGuard?.();
          store[params.target.canonicalKey] = nextEntry;
          mutation = { nextEntry, previousEntry, previousSessionId: previousEntry?.sessionId };
          return nextEntry;
        },
      );
      if (!mutation) {
        throw new Error("Reset fixture did not commit a session entry");
      }
      await params.afterEntryMutation?.(mutation, {
        env: {},
        source: { agentId: params.agentId ?? "main", path: params.storePath },
        assertCurrent: () => params.commitGuard?.(),
      });
      return { ...mutation, archivedTranscripts: [] };
    });
    mocks.patchSessionEntryTarget.mockReset().mockImplementation(
      async (
        scope: { storePath: string; target: SessionEntryTargetFixture },
        update: (
          entry: Record<string, unknown>,
          context: { existingEntry?: Record<string, unknown> },
        ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
        options: {
          fallbackEntry?: Record<string, unknown>;
          replaceEntry?: boolean;
          onCommitted?: (entry: Record<string, unknown>) => void;
        } = {},
      ) => {
        let committed: Record<string, unknown> | undefined;
        const result = await mocks.updateSessionStore(
          scope.storePath,
          async (store: SessionStoreFixture) => {
            const existing = selectFreshestTargetFixtureEntry(store, scope.target);
            const base = existing?.entry ?? options.fallbackEntry;
            if (!base) {
              return null;
            }
            const patchContext = existing ? { existingEntry: structuredClone(existing.entry) } : {};
            const patch = await update(structuredClone(base), patchContext);
            if (!patch) {
              return cloneSessionStoreFixtureEntry(base);
            }
            const fresh = selectFreshestTargetFixtureEntry(store, scope.target);
            const writeBase = fresh?.entry ?? options.fallbackEntry;
            if (!writeBase) {
              return null;
            }
            const next = options.replaceEntry ? structuredClone(patch) : { ...writeBase, ...patch };
            for (const key of new Set([scope.target.canonicalKey, ...scope.target.storeKeys])) {
              delete store[key];
            }
            store[scope.target.canonicalKey] = next;
            committed = next;
            return next;
          },
          options,
        );
        if (committed) {
          options.onCommitted?.(committed);
        }
        return result;
      },
    );
  };
}
