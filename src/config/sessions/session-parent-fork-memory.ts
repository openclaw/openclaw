import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { ForkSessionFromParentTranscriptParams } from "./session-accessor.types.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

/** Read the selected source owner without creating a parent or a staging transcript. */
export async function readMemoryParentForkSource(
  input: ForkSessionFromParentTranscriptParams,
  binding: SessionActorStorageBinding,
) {
  const sessionKey = normalizeStoreSessionKey(input.parentSessionKey);
  const agentId = input.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
  const authority: SessionActorStorageAuthority = {
    authorize: (stage, facts, publication) =>
      binding.authority.authorize(stage, facts, publication),
    assertCurrent() {
      binding.actor.assertReadable();
      binding.authority.assertCurrent();
      input.commitGuard?.();
    },
  };
  const selected =
    agentId === binding.agentId
      ? getSessionActorStorageBinding({
          agentId,
          storePath: input.storePath,
          sessionActor: binding,
        })
      : undefined;
  const captured = selected
    ? undefined
    : captureSessionActorStorageOwner({
        agentId,
        sessionKey,
        storePath: input.storePath,
        sessionActor: binding,
      });
  const actor =
    selected?.actor ??
    (await captured?.owner?.acquireExisting(sessionKey, {
      assertCurrent: () => authority.assertCurrent(),
      assertReadable: () => authority.assertCurrent(),
    }));
  if (!actor) {
    authority.assertCurrent();
    return undefined;
  }
  try {
    const source = await actor.storage!.read(
      {
        type: "session.parentFork.source",
        input: { sessionKey, sessionId: input.parentEntry.sessionId, forkFrom: input.forkFrom },
      },
      authority,
    );
    return { source, scope: { agentId, path: selected?.path ?? captured!.path } };
  } finally {
    if (!selected) {
      await actor.release();
    }
  }
}
