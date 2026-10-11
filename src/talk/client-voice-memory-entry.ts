import type {
  CapturedSessionActorStorageOwner,
  SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { SessionEntryPatchOperation } from "../config/sessions/session-entry-patch-operation.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import {
  prepareSessionSourceAuthority,
  type SessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";

/** Only the conversation entry moves to memory; voice-call metadata keeps its durable owner. */
export async function ensureMemoryVoiceEntry(params: {
  binding: SessionActorStorageBinding;
  operation: SessionEntryPatchOperation;
  fallbackEntry: InternalSessionEntry;
  assertCurrent(): void;
  onCommitted?: (entry: InternalSessionEntry) => void;
  onCommittedSource?: (source: CapturedSessionEntryReadSource, entry: InternalSessionEntry) => void;
}): Promise<InternalSessionEntry | null> {
  const { binding } = params;
  const outcome = await binding.actor.storage!.mutate(
    {
      type: "session.entry.patch",
      input: { operation: params.operation, fallbackEntry: params.fallbackEntry },
    },
    {
      ...binding.authority,
      assertCurrent() {
        binding.authority.assertCurrent();
        params.assertCurrent();
      },
    },
    {
      committed(result) {
        const entry = result.value;
        if (!entry) {
          return;
        }
        params.onCommitted?.(entry);
        const database = binding.actor.target.database;
        if (database.kind === "memory") {
          params.onCommittedSource?.(
            {
              agentId: binding.agentId,
              path: binding.path,
              databaseIdentity: database.incarnation,
            },
            entry,
          );
        }
      },
    },
  );
  if (outcome.kind !== "committed") {
    throw new Error(outcome.error.message);
  }
  if (outcome.failure) {
    throw new Error(outcome.failure.message);
  }
  return outcome.value ?? null;
}

/** The live memory source is checked by the durable voice writer at its effect boundary. */
export async function prepareMemoryVoiceSource(
  binding: CapturedSessionActorStorageOwner,
  source: SessionSourceAssertion,
): Promise<PreparedSessionSourceAuthority> {
  const prepared = await prepareSessionSourceAuthority(source);
  return {
    ...prepared,
    assertCurrent() {
      binding.binding?.actor.assertReadable();
      binding.authority.assertCurrent();
      prepared.assertCurrent();
    },
  };
}
