import { AsyncLocalStorage } from "node:async_hooks";
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
  scopedSources?: ReadonlyMap<SessionSourceAssertion, PreparedSessionSourceAuthority>;
};

export type SessionSourceAssertion = (() => void) & {
  nativeSource?: boolean;
  /** Checks the scope owner without invoking storage-dependent source predicates. */
  assertScopeCurrent?: () => void;
  prepareSessionSource?: () => Promise<PreparedSessionSourceAuthority>;
  prepareSessionSourceScope?: () => Promise<PreparedSessionSourceAuthority | undefined>;
};

const sessionSourceScopes = new AsyncLocalStorage<
  ReadonlyMap<SessionSourceAssertion, PreparedSessionSourceAuthority>
>();

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

export async function prepareSessionSourceScope(
  assertion: SessionSourceAssertion | undefined,
): Promise<PreparedSessionSourceAuthority | undefined> {
  return assertion?.prepareSessionSourceScope?.();
}

export function bindPreparedSessionSourceAssertion(
  source: SessionSourceAssertion,
  prepared: PreparedSessionSourceAuthority,
): SessionSourceAssertion & { release(): Promise<void> } {
  let active = true;
  const assertRetained = () => {
    if (!active) {
      throw new Error("Session source authority has been released");
    }
  };
  const retainedSource = composeSessionSourceAssertion([source], (assertSource) => {
    assertRetained();
    assertSource();
  });
  const assertion = composeSessionSourceAssertion([
    assertRetained,
    Object.assign(() => prepared.assertCurrent(), {
      nativeSource: prepared.nativeSource,
      prepareSessionSource: () => {
        assertRetained();
        return prepareSessionSourceAuthority(retainedSource);
      },
      prepareSessionSourceScope: () => {
        assertRetained();
        return prepareSessionSourceScope(retainedSource);
      },
    }),
  ]);
  return Object.assign(assertion, {
    release() {
      active = false;
      return releaseSessionSourceAuthorities([prepared]);
    },
  });
}

/** A fence owns its live source predicates until all work inside that scope settles. */
export async function runWithSessionSourceScope<T>(
  assertion: SessionSourceAssertion | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const prepared = assertion?.prepareSessionSourceScope
    ? await prepareSessionSourceScope(assertion)
    : undefined;
  if (!assertion || !prepared) {
    assertion?.assertScopeCurrent?.();
    const result = await run();
    assertion?.assertScopeCurrent?.();
    return result;
  }
  const scopes = new Map([
    ...(sessionSourceScopes.getStore() ?? []),
    ...(prepared.scopedSources ?? []),
  ]);
  scopes.set(assertion, prepared);
  const errors: unknown[] = [];
  try {
    return await sessionSourceScopes.run(scopes, async () => {
      (prepared.assertPreparedCurrent ?? prepared.assertCurrent)();
      const result = await run();
      (prepared.assertPreparedCurrent ?? prepared.assertCurrent)();
      return result;
    });
  } catch (error) {
    errors.push(error);
    throw error;
  } finally {
    await releaseSessionSourceAuthorities([prepared], errors);
  }
}

/** A live selector may advance between operations, never during one prepared write. */
export function createDynamicSessionSourceAssertion(
  select: () => SessionSourceAssertion | undefined,
  refuse: () => never,
): SessionSourceAssertion {
  const prepareSelected = <T>(
    prepare: (assertion: SessionSourceAssertion | undefined) => Promise<T>,
  ) => {
    const selected = select();
    return prepare(
      composeSessionSourceAssertion([selected], (assertSource) => {
        if (select() !== selected) {
          refuse();
        }
        assertSource();
      }),
    );
  };
  const assertion: SessionSourceAssertion = Object.assign(
    () => {
      const scoped = sessionSourceScopes.getStore()?.get(assertion);
      return scoped ? scoped.assertCurrent() : select()?.();
    },
    {
      prepareSessionSource: () => prepareSelected(prepareSessionSourceAuthority),
      prepareSessionSourceScope: () => prepareSelected(prepareSessionSourceScope),
    },
  );
  return assertion;
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
  function prepare(scoped: true): Promise<PreparedSessionSourceAuthority | undefined>;
  function prepare(scoped?: false): Promise<PreparedSessionSourceAuthority>;
  async function prepare(scoped = false): Promise<PreparedSessionSourceAuthority | undefined> {
    const prepared: PreparedSessionSourceAuthority[] = [];
    const scopedSources = new Map<SessionSourceAssertion, PreparedSessionSourceAuthority>();
    const release = () => releaseSessionSourceAuthorities(prepared);
    const assertPreparedSources = () => {
      for (const source of prepared) {
        if (source.assertPreparedCurrent) {
          source.assertPreparedCurrent();
        } else if (!source.nativeSource) {
          source.assertCurrent();
        }
      }
    };
    try {
      for (const source of sources) {
        const value = scoped
          ? await prepareSessionSourceScope(source)
          : await prepareSessionSourceAuthority(source);
        if (scoped && value && source) {
          for (const [assertion, nested] of value.scopedSources ?? []) {
            scopedSources.set(assertion, nested);
          }
          scopedSources.set(source, value);
        }
        prepared.push(
          value ?? {
            assertCurrent: () => source?.(),
            ...(scoped ? { assertPreparedCurrent: () => source?.assertScopeCurrent?.() } : {}),
            checks: [],
            nativeSource: source?.nativeSource,
          },
        );
      }
      if (scoped && scopedSources.size === 0) {
        return undefined;
      }
      return {
        nativeSource: prepared.some((source) => source.nativeSource),
        hasOpaqueCheck: options?.hasOpaqueCheck || prepared.some((source) => source.hasOpaqueCheck),
        assertCurrent: () => check(() => prepared.forEach((source) => source.assertCurrent())),
        assertPreparedCurrent: () => (options?.preparedCheck ?? check)(assertPreparedSources),
        ...(scoped ? { scopedSources } : {}),
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
        (scoped ? (options?.preparedCheck ?? check) : check)(() => {
          if (scoped) {
            assertPreparedSources();
          } else {
            prepared.forEach((source) => source.assertCurrent());
          }
          throw error;
        });
      } catch (translatedError) {
        failure = translatedError;
      }
      await releaseSessionSourceAuthorities(prepared, [failure]);
      throw failure;
    }
  }
  const assertion: SessionSourceAssertion = Object.assign(
    () => {
      const scoped = sessionSourceScopes.getStore()?.get(assertion);
      return scoped ? scoped.assertCurrent() : check(() => sources.forEach((source) => source?.()));
    },
    {
      prepareSessionSource: () => prepare(),
      prepareSessionSourceScope: () => prepare(true),
    },
  );
  return assertion;
}
