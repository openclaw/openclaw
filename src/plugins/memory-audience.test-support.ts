// Fake session generation owner for memory audience tests. Each lease rechecks
// the captured incarnation against the fake committed rows, as the real owner's
// publication-updated facts do, without SQLite or worker threads.
import { ok, type Result } from "@openclaw/normalization-core/result";
import type { SessionEntry } from "../config/sessions/types.js";

export type FakeSessionRow = Partial<SessionEntry> & { sessionId: string; updatedAt: number };

export const fakeSessionOwner = {
  rows: new Map<string, FakeSessionRow>(),
  pendingKeys: new Set<string>(),
  publications: new Map<string, Promise<void>>(),
  workerReads: [] as string[],
  activeLeases: 0,
  reset() {
    this.rows.clear();
    this.pendingKeys.clear();
    this.publications.clear();
    this.workerReads.length = 0;
    this.activeLeases = 0;
  },
};

class FakeRevokedError extends Error {
  readonly code = "SESSION_DELIVERY_GENERATION_REVOKED";
}

function assertGeneration(input: {
  sessionKey: string;
  sessionId: string | null;
  lifecycleRevision: string | null;
}) {
  const row = fakeSessionOwner.rows.get(input.sessionKey);
  if (
    (row?.sessionId ?? null) !== input.sessionId ||
    (row?.lifecycleRevision ?? null) !== input.lifecycleRevision
  ) {
    throw new FakeRevokedError("The original session generation no longer accepts this delivery.");
  }
}

/** Module factory for `config/sessions/session-delivery-generation.js`. */
export const fakeSessionGenerationModule = {
  isSessionDeliveryGenerationRevokedError: (error: unknown) => error instanceof FakeRevokedError,
  prepareSessionGenerationFacts: async (input: {
    sessionKey: string;
    sessionId: string | null;
    lifecycleRevision: string | null;
  }) => {
    assertGeneration(input);
    let active = true;
    fakeSessionOwner.activeLeases += 1;
    return {
      assertCurrent: () => {
        if (!active || fakeSessionOwner.pendingKeys.has(input.sessionKey)) {
          throw new Error("Session delivery generation is unavailable");
        }
        assertGeneration(input);
      },
      prepareRead: () => {
        if (!active) {
          throw new Error("Session delivery generation is unavailable");
        }
        return fakeSessionOwner.publications.get(input.sessionKey);
      },
      release: () => {
        if (active) {
          active = false;
          fakeSessionOwner.activeLeases -= 1;
        }
      },
    };
  },
};

/** Module factory for `config/sessions/session-entry-read-runtime.js`. */
export const fakeSessionEntryReadModule = {
  withSessionEntryReadOnlyInWorker: async <T>(
    scope: { sessionKey: string },
    assertCallerCurrent: () => void,
    consume: (read: Result<FakeSessionRow | undefined, unknown>) => Promise<T>,
  ) => {
    assertCallerCurrent();
    fakeSessionOwner.workerReads.push(scope.sessionKey);
    return await consume(ok(fakeSessionOwner.rows.get(scope.sessionKey)));
  },
};
