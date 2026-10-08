import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Prepared source facts are compared again on the existing writer's connection. */
export type SessionSourcePredicate = {
  source: CapturedSessionEntryReadSource;
  sessionKey: string;
  fields: (keyof SessionEntry)[];
  expected: Partial<SessionEntry> | undefined;
  members?: readonly string[];
  transcript?: { sessionId: string; version: SessionTranscriptContextVersion };
};

export type SessionSourcePredicateFacts = {
  entry: SessionEntry | undefined;
  members?: readonly string[];
};

export type PreparedSessionSourceAuthority = {
  /** Process-held sources require native atomicity when writing a durable target. */
  nativeSource?: boolean;
  /** Wrapper checks need a native transaction unless the caller owns a prepared commit hook. */
  hasOpaqueCheck?: boolean;
  assertCurrent: () => void;
  /** Prepared components only; the owning commit boundary must also run opaque checks. */
  assertPreparedCurrent?: () => void;
  checks: {
    predicate: SessionSourcePredicate;
    refuse: (facts: SessionSourcePredicateFacts) => never;
  }[];
  release?: () => void | Promise<void>;
};

export type SessionSourceAssertion = (() => void) & {
  nativeSource?: boolean;
  prepareSessionSource?: () => Promise<PreparedSessionSourceAuthority>;
};

/** Classify request/SDK callbacks before adapters compose them with prepared internal authority. */
export function captureExternalSessionCommitGuard(guard: SessionSourceAssertion | undefined) {
  return guard && !guard.prepareSessionSource
    ? Object.assign(() => guard(), { nativeSource: true })
    : guard;
}

export async function releaseSessionSourceAuthorities(
  sources: readonly Pick<PreparedSessionSourceAuthority, "release">[],
  priorErrors: readonly unknown[] = [],
): Promise<void> {
  const errors: unknown[] = [...priorErrors];
  for (const source of sources.toReversed()) {
    try {
      await source.release?.();
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Session source cleanup failed");
}

export async function prepareSessionSourceAuthority(
  assertion: SessionSourceAssertion | undefined,
): Promise<PreparedSessionSourceAuthority> {
  return assertion?.prepareSessionSource
    ? assertion.prepareSessionSource()
    : { assertCurrent: () => assertion?.(), checks: [], nativeSource: assertion?.nativeSource };
}

/** A live selector may advance between operations, never during one prepared write. */
export function createDynamicSessionSourceAssertion(
  select: () => SessionSourceAssertion | undefined,
  refuse: () => never,
): SessionSourceAssertion {
  return Object.assign(() => select()?.(), {
    prepareSessionSource() {
      const selected = select();
      return prepareSessionSourceAuthority(
        composeSessionSourceAssertion([selected], (assertSource) => {
          if (select() !== selected) {
            refuse();
          }
          assertSource();
        }),
      );
    },
  });
}

/** Preserve each owner's error/lifetime wrapper while preparing its storage-dependent sources. */
export function composeSessionSourceAssertion(
  sources: readonly (SessionSourceAssertion | undefined)[],
  check: (assertSources: () => void) => void = (assertSources) => assertSources(),
  options?: {
    preparedCheck: (assertSources: () => void) => void;
    hasOpaqueCheck?: boolean;
  },
): SessionSourceAssertion {
  return Object.assign(() => check(() => sources.forEach((source) => source?.())), {
    async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
      const prepared: PreparedSessionSourceAuthority[] = [];
      const release = () => releaseSessionSourceAuthorities(prepared);
      try {
        for (const source of sources) {
          prepared.push(await prepareSessionSourceAuthority(source));
        }
        return {
          nativeSource: prepared.some((source) => source.nativeSource),
          hasOpaqueCheck:
            options?.hasOpaqueCheck || prepared.some((source) => source.hasOpaqueCheck),
          assertCurrent: () => check(() => prepared.forEach((source) => source.assertCurrent())),
          assertPreparedCurrent: () =>
            (options?.preparedCheck ?? check)(() => {
              for (const source of prepared) {
                if (source.assertPreparedCurrent) {
                  source.assertPreparedCurrent();
                } else if (!source.nativeSource) {
                  source.assertCurrent();
                }
              }
            }),
          checks: prepared.flatMap((source, index) =>
            source.checks.map(({ predicate, refuse }) => ({
              predicate,
              refuse: (facts) => {
                check(() => {
                  prepared.slice(0, index).forEach((previous) => previous.assertCurrent());
                  refuse(facts);
                });
                throw new Error("Source authority refusal was suppressed");
              },
            })),
          ),
          release,
        };
      } catch (error) {
        let failure = error;
        try {
          check(() => {
            prepared.forEach((source) => source.assertCurrent());
            throw error;
          });
        } catch (translatedError) {
          failure = translatedError;
        }
        await releaseSessionSourceAuthorities(prepared, [failure]);
        throw failure;
      }
    },
  });
}
