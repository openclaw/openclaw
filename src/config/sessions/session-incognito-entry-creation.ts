import {
  withSessionEntryCreationPublication,
  runWithSessionEntryCreationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryCreateWithTranscriptContext,
  SessionEntryCreateWithTranscriptOptions,
  SessionEntryCreateWithTranscriptPrepareResult,
  SessionEntryCreateWithTranscriptResult,
} from "./session-accessor.types.js";
import {
  publishIncognitoSessionEntry,
  withIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "./session-incognito-binding.js";

/** Retain the selected actor through preparation, acknowledged publication, and bookkeeping. */
export function createIncognitoSessionEntryWithTranscript<TError>(
  binding: IncognitoSessionBinding,
  scope: ResolvedSqliteScope & { path: string; env: NodeJS.ProcessEnv },
  createEntry: (
    context: SessionEntryCreateWithTranscriptContext,
  ) =>
    | Promise<SessionEntryCreateWithTranscriptPrepareResult<TError>>
    | SessionEntryCreateWithTranscriptPrepareResult<TError>,
  options: SessionEntryCreateWithTranscriptOptions,
): Promise<SessionEntryCreateWithTranscriptResult<TError>> {
  const { actor } = binding;
  const sessionKey = scope.sessionKey;
  const assertCurrent = () => {
    actor.assertCurrent();
    options.commitGuard?.();
  };
  assertCurrent();
  binding.admissionSignal?.throwIfAborted();
  return actor.sessions.withSharedState(async () => {
    let held: ReturnType<typeof actor.sessions.captureSnapshot> | undefined;
    const prepared = await actor.sessions.entry(
      { assertCurrent },
      {
        type: "session.entry.creation.prepare",
        input: { sessionKey, label: options.label },
      },
      binding.admissionSignal,
      undefined,
      () => {
        held = actor.sessions.captureSnapshot(sessionKey);
      },
    );
    assertCurrent();
    held?.assertCurrent();
    return withSessionEntryCreationPublication(
      {
        agentId: actor.agentId,
        sessionKey,
        bind: options.bindCreation,
        file: {
          kind: "actor",
          path: actor.path,
          agentId: actor.agentId,
          databaseIdentity: actor.identity.incarnation,
          assertCurrent: () => actor.assertCurrent(),
        },
      },
      async (operation) => {
        options.onPhase?.("entry");
        const created = await createEntry(structuredClone(prepared));
        assertCurrent();
        held?.assertCurrent();
        if (!created.ok) {
          return { ok: false, error: created.error, phase: "entry" };
        }
        const input = structuredClone({
          sessionKey,
          prepared,
          entry: created.entry,
          label: options.label,
          cwd: options.cwd,
          transcriptEvents: created.transcriptEvents,
          owner: options.resolveOwnerAssignment?.(),
        });
        const commit = async (assertSourceCurrent?: () => void) => {
          const assertHeld = () => {
            assertCurrent();
            assertSourceCurrent?.();
          };
          assertHeld();
          held?.assertCurrent();
          options.onPhase?.("commit");
          const entry = await actor.sessions.entry(
            { assertCurrent: assertHeld },
            {
              type: "session.entry.creation.commit",
              input,
            },
            undefined,
            (committed) => {
              try {
                options.onLifecycleCommitted?.(structuredClone(committed));
              } finally {
                publishIncognitoSessionEntry(actor, sessionKey, prepared.targetEntry, committed);
              }
            },
          );
          if (options.afterCommitted) {
            let active = true;
            try {
              await options.afterCommitted(entry, {
                env: scope.env,
                assertCurrent() {
                  if (!active) {
                    throw new Error("Session commit owner is no longer current");
                  }
                  assertHeld();
                },
              });
              assertHeld();
            } finally {
              active = false;
            }
          }
          return { ok: true as const, entry, sessionFile: sessionKey };
        };
        return options.withCommit
          ? options.withCommit((assertSourceCurrent) =>
              withIncognitoSessionBinding(binding, () =>
                runWithSessionEntryCreationPublication(operation, () =>
                  commit(assertSourceCurrent),
                ),
              ),
            )
          : commit();
      },
    );
  });
}
