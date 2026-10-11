import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type {
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
} from "./session-accessor.types.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  withSessionActorStorage,
  type SessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import type { SessionActorStorageAuthority } from "./session-actor-storage-contract.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import type { ParentForkEntryPatch } from "./session-parent-fork.types.js";
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

export function forkMemorySessionEntryFromParent(
  params: ForkSessionEntryFromParentTargetParams,
  patch?: ParentForkEntryPatch,
): Promise<ForkSessionEntryFromParentTargetResult> | undefined {
  const assertCurrent = () => params.commitGuard?.();
  const authority = { assertCurrent, authorize() {} };
  const scope = { ...params, sessionKey: params.parentTarget.canonicalKey };
  if (!captureSessionActorStorageOwner(scope, authority)) {
    return undefined;
  }
  return withSessionActorStorage(
    scope,
    {
      authority,
      lifetime: { assertCurrent, assertReadable: assertCurrent },
    },
    async (memory) => {
      const { cliBackendSupportsSessionFork } = await import("../../agents/cli-backends.js");
      const {
        commitGuard: _guard,
        patch: callback,
        skipPatch,
        skipForkWhen,
        decisionSkipPatch,
        ...data
      } = params;
      return readSessionActorStorageResult(
        await memory.actor.storage.mutate(
          {
            type: "session.parentFork.commit",
            input: {
              kind: "entry",
              params: structuredClone(data),
              patch: patch && structuredClone(patch),
              supportsCliFork: cliBackendSupportsSessionFork,
              callbacks: { patch: callback, skipPatch, skipForkWhen, decisionSkipPatch },
            },
          },
          memory.authority,
        ),
      );
    },
  ).then((result) => result ?? { status: "missing-parent" });
}
