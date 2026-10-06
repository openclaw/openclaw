import { AsyncLocalStorage } from "node:async_hooks";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionEntry } from "./types.js";

export type SessionPendingInputAuthorityFacts = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  entry: SessionEntry | undefined;
  readSource?: CapturedSessionEntryReadSource;
  members: readonly SessionMember[];
};

/** Host custody checks consume fresh worker facts without extending a snapshot across awaits. */
export type SessionPendingInputAuthority = {
  assertLifetimeCurrent: () => void;
  withCurrent: <T>(
    consume: (facts: SessionPendingInputAuthorityFacts, assertSourceCurrent: () => void) => T,
  ) => Promise<T>;
  withPreparedCurrent: <T>(
    facts: SessionPendingInputAuthorityFacts,
    consume: () => T,
    assertSourceCurrent: () => void,
  ) => T;
};

export async function withCurrentPendingInputAuthority<T>(
  authorities: readonly SessionPendingInputAuthority[],
  assertLifetimeCurrent: () => void,
  run: () => T,
): Promise<Awaited<T>> {
  const authority = authorities[0];
  if (!authority) {
    return await run();
  }
  assertLifetimeCurrent();
  for (const source of authorities.slice(1)) {
    await source.withCurrent(() => undefined);
    assertLifetimeCurrent();
  }
  const runInCallerContext = AsyncLocalStorage.snapshot();
  let initiated: Promise<Awaited<T>> | undefined;
  try {
    const result = await authority.withCurrent((facts, assertSourceCurrent) => {
      const enter = (index: number): { value: Promise<Awaited<T>> } => {
        const source = authorities[index];
        if (source) {
          return source.withPreparedCurrent(facts, () => enter(index + 1), assertSourceCurrent);
        }
        initiated = Promise.resolve(runInCallerContext(run));
        void initiated.catch(() => {});
        return { value: initiated };
      };
      return enter(0);
    });
    return await result.value;
  } catch (error) {
    // Reader cleanup cannot abandon accepted work or hide an unknown write outcome.
    await initiated;
    throw error;
  }
}

export function withSessionPendingInputAuthorityGuard(
  authority: SessionPendingInputAuthority,
  assertCurrent: () => void,
  rejectPreparation?: (cause: unknown) => never,
): SessionPendingInputAuthority {
  return {
    assertLifetimeCurrent() {
      try {
        authority.assertLifetimeCurrent();
        assertCurrent();
      } catch (cause) {
        rejectPreparation?.(cause);
        throw cause;
      }
    },
    async withCurrent(consume) {
      let consuming = false;
      try {
        assertCurrent();
        return await authority.withCurrent((facts, assertSourceCurrent) => {
          assertCurrent();
          consuming = true;
          return consume(facts, assertSourceCurrent);
        });
      } catch (cause) {
        if (!consuming) {
          rejectPreparation?.(cause);
        }
        throw cause;
      }
    },
    withPreparedCurrent(facts, consume, assertSourceCurrent) {
      let consuming = false;
      try {
        return authority.withPreparedCurrent(
          facts,
          () => {
            assertCurrent();
            consuming = true;
            return consume();
          },
          assertSourceCurrent,
        );
      } catch (cause) {
        if (!consuming) {
          rejectPreparation?.(cause);
        }
        throw cause;
      }
    },
  };
}
