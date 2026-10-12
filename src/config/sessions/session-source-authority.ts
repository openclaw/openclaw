import { AsyncLocalStorage } from "node:async_hooks";
import { throwSqliteLifecycleErrors } from "../../infra/sqlite-lifecycle-errors.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionSourceConversationPredicate = {
  conversationRef: string;
  sessionKey: string | null;
};

/** Prepared source facts are compared again on the existing writer's connection. */
export type SessionSourcePredicate = {
  source: CapturedSessionEntryReadSource;
  sessionKey: string;
  fields: (keyof SessionEntry)[];
  expected: Partial<SessionEntry> | undefined;
  members?: readonly string[];
  transcript?: { sessionId: string; version: SessionTranscriptContextVersion };
  conversationAlternatives?: readonly (readonly SessionSourceConversationPredicate[])[];
};

export type SessionSourcePredicateFacts = {
  entry: SessionEntry | undefined;
  members?: readonly string[];
};

/** Current source facts supplied by the mutation's own transaction. */
export type SessionSourceTransactionGrant = {
  source: CapturedSessionEntryReadSource;
  agentId: string;
  sessionKey: string;
  assertCurrent: (facts: SessionPendingInputAuthorityFacts) => void;
};

export type SessionSourceWriteGrant = {
  assertCurrent: () => void;
  assertLifetimeCurrent: () => void;
  release: () => void | Promise<void>;
  transaction?: SessionSourceTransactionGrant;
};

export type SessionSourceValidation = {
  refusedSource?: { index: number; facts: SessionSourcePredicateFacts };
  conversationMatches: Array<{
    index: number;
    alternatives: number[];
    acceptedAlternatives?: number[];
  }>;
};

export type PreparedSessionSourceAuthority = {
  transaction?: SessionSourceTransactionGrant;
  /** Process-held sources require native atomicity when writing a durable target. */
  nativeSource?: boolean;
  /** Released SDK callbacks can perform arbitrary synchronous SQLite reads. */
  opaqueCommitGuard?: boolean;
  /** Wrapper checks need a native transaction unless the caller owns a prepared commit hook. */
  hasOpaqueCheck?: boolean;
  assertCurrent: () => void;
  /** Prepared components only; the owning commit boundary must also run opaque checks. */
  assertPreparedCurrent?: () => void;
  checks: {
    predicate: SessionSourcePredicate;
    refuse: (facts: SessionSourcePredicateFacts) => never;
    /** The returned array is filled by the next host assertion. */
    acceptConversationMatches?: (alternatives: readonly number[]) => number[];
  }[];
  release?: () => void | Promise<void>;
  scopedSources?: ReadonlyMap<SessionSourceAssertion, PreparedSessionSourceAuthority>;
};

export type SessionSourceAssertion = (() => void) & {
  nativeSource?: boolean;
  opaqueCommitGuard?: boolean;
  /** Checks the scope owner without invoking storage-dependent source predicates. */
  assertScopeCurrent?: () => void;
  prepareSessionSource?: () => Promise<PreparedSessionSourceAuthority>;
  prepareSessionSourceScope?: () => Promise<PreparedSessionSourceAuthority | undefined>;
};

/** Sources supplied to worker mutation APIs must own asynchronous predicate preparation. */
export type PreparedSessionSourceAssertion = SessionSourceAssertion & {
  prepareSessionSource: () => Promise<PreparedSessionSourceAuthority>;
};

/** Public boolean callbacks stay callable; bundled owners also carry their prepared writer source. */
export type SessionSourceCheck = (() => boolean) & { sessionSource?: SessionSourceAssertion };

/** Async effect checks also expose worker predicates and a storage-free host assertion. */
export type AsyncSessionSourceCheck = (() => Promise<boolean>) & {
  sessionSource: PreparedSessionSourceAssertion & { assertScopeCurrent: () => void };
};

export function sessionEntryCommitGuardOptions(source: SessionSourceAssertion | undefined) {
  return source?.nativeSource ? { assertCommitAllowed: source } : { workerGuard: { source } };
}

/** Install transaction facts before composed host assertions recheck their live alternatives. */
export function acceptSessionSourceValidation(
  source: PreparedSessionSourceAuthority,
  validation: SessionSourceValidation | undefined,
): void {
  const refused = validation?.refusedSource;
  if (refused) {
    source.checks[refused.index]?.refuse(refused.facts);
    throw new Error("Session source refusal omitted its prepared assertion");
  }
  for (const [index, check] of source.checks.entries()) {
    if (!check.acceptConversationMatches) {
      continue;
    }
    const matched = validation?.conversationMatches.find((entry) => entry.index === index);
    if (
      !matched ||
      matched.alternatives.some(
        (alternative) =>
          !Number.isSafeInteger(alternative) ||
          alternative < 0 ||
          alternative >= (check.predicate.conversationAlternatives?.length ?? 0),
      )
    ) {
      throw new Error("Session source validation omitted its matching alternatives");
    }
    matched.acceptedAlternatives = check.acceptConversationMatches(matched.alternatives);
  }
}

const sessionSourceScopes = new AsyncLocalStorage<
  ReadonlyMap<SessionSourceAssertion, PreparedSessionSourceAuthority>
>();

/** Classify request/SDK callbacks before adapters compose them with prepared internal authority. */
export function captureExternalSessionCommitGuard(guard: SessionSourceAssertion | undefined) {
  return guard && !guard.prepareSessionSource
    ? Object.assign(() => guard(), { nativeSource: true, opaqueCommitGuard: true })
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
    : {
        assertCurrent: () => assertion?.(),
        checks: [],
        nativeSource: assertion?.nativeSource,
        opaqueCommitGuard: assertion?.opaqueCommitGuard,
      };
}

/** Bootstrap grants consume prepared liveness, never opaque or native source reads. */
export function assertPreparedSessionSourceCurrent(source: PreparedSessionSourceAuthority): void {
  if (source.assertPreparedCurrent) {
    source.assertPreparedCurrent();
  } else if (!source.nativeSource) {
    source.assertCurrent();
  }
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
      opaqueCommitGuard: prepared.opaqueCommitGuard,
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
): PreparedSessionSourceAssertion {
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
  const assertion: PreparedSessionSourceAssertion = Object.assign(
    () => {
      const scoped = sessionSourceScopes.getStore()?.get(assertion);
      return scoped ? scoped.assertCurrent() : select()?.();
    },
    {
      prepareSessionSource: () => prepareSelected(prepareSessionSourceAuthority),
      prepareSessionSourceScope: () => prepareSelected(prepareSessionSourceScope),
    },
  );
  return Object.defineProperty(assertion, "nativeSource", {
    enumerable: true,
    get: () => select()?.nativeSource,
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
): PreparedSessionSourceAssertion {
  function prepare(scoped: true): Promise<PreparedSessionSourceAuthority | undefined>;
  function prepare(scoped?: false): Promise<PreparedSessionSourceAuthority>;
  async function prepare(scoped = false): Promise<PreparedSessionSourceAuthority | undefined> {
    const prepared: PreparedSessionSourceAuthority[] = [];
    const scopedSources = new Map<SessionSourceAssertion, PreparedSessionSourceAuthority>();
    const release = () => releaseSessionSourceAuthorities(prepared);
    const assertPreparedSources = () => {
      for (const source of prepared) {
        assertPreparedSessionSourceCurrent(source);
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
            opaqueCommitGuard: source?.opaqueCommitGuard,
          },
        );
      }
      if (scoped && scopedSources.size === 0) {
        return undefined;
      }
      return {
        nativeSource: prepared.some((source) => source.nativeSource),
        opaqueCommitGuard: prepared.some((source) => source.opaqueCommitGuard),
        hasOpaqueCheck: options?.hasOpaqueCheck || prepared.some((source) => source.hasOpaqueCheck),
        assertCurrent: () => check(() => prepared.forEach((source) => source.assertCurrent())),
        assertPreparedCurrent: () => (options?.preparedCheck ?? check)(assertPreparedSources),
        ...(scoped ? { scopedSources } : {}),
        checks: prepared.flatMap((source, index) =>
          source.checks.map(({ refuse, ...preparedCheck }) => ({
            ...preparedCheck,
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
  const assertion: PreparedSessionSourceAssertion = Object.assign(
    () => {
      const scoped = sessionSourceScopes.getStore()?.get(assertion);
      return scoped ? scoped.assertCurrent() : check(() => sources.forEach((source) => source?.()));
    },
    {
      prepareSessionSource: () => prepare(),
      prepareSessionSourceScope: () => prepare(true),
    },
  );
  return Object.defineProperty(assertion, "nativeSource", {
    enumerable: true,
    get: () => sources.some((source) => source?.nativeSource),
  });
}
