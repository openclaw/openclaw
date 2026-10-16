import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../../../config/sessions/session-actor-storage-binding.js";

/** Retain the selected logical session; absence never creates a replacement owner. */
export async function withSubagentSessionSource<T>(
  input: {
    agentId: string;
    sessionKey: string;
    storePath?: string;
    assertCurrent?: () => void;
  },
  consume: (source: SessionActorStorageBinding | undefined) => Promise<T>,
): Promise<T> {
  const assertCurrent = () => input.assertCurrent?.();
  const source = await acquireSessionActorStorage(input, {
    lifetime: { assertCurrent, assertReadable: assertCurrent },
    authority: { assertCurrent, authorize() {} },
  });
  if (!source) {
    return consume(undefined);
  }
  try {
    return await runWithSessionActorStorage(source, () => consume(source));
  } finally {
    await source.actor.release();
  }
}
