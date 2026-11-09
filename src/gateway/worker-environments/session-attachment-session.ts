import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { readResolvedSessionStoreTargetsInWorker } from "../../config/sessions/session-accessor.entry-read-runtime.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { WorkerEnvironmentSessionIdentity } from "./session-attachment.js";

/** Retain the selected conversation generation for an attachment or its creating operation. */
export async function prepareWorkerEnvironmentAttachmentSession(
  identity: WorkerEnvironmentSessionIdentity,
  options: { getConfig: () => OpenClawConfig; isStopping: () => boolean },
) {
  const cfg = options.getConfig();
  const sessionStorePath = () =>
    resolveSessionStorePathCore(options.getConfig().session?.store, { agentId: identity.agentId });
  const configuredPath = sessionStorePath();
  const target = (
    await readResolvedSessionStoreTargetsInWorker({
      cfg,
      agentId: identity.agentId,
      sessionKeys: [identity.sessionKey],
    })
  ).get(identity.sessionKey);
  if (!target) {
    throw new Error("Conversation environment session could not be resolved");
  }
  let active = true;
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let unregister = () => {};
  const release = () => {
    active = false;
    retained?.release();
    unregister();
  };
  const assertActive = () => {
    if (!active || options.isStopping() || sessionStorePath() !== configuredPath) {
      throw new Error("Conversation environment requester is no longer current");
    }
  };
  try {
    const entry = await withSessionEntryReadOnlyInWorker(
      { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath },
      assertActive,
      async (read, owner) => {
        if (!read.ok) {
          throw read.error;
        }
        if (owner.kind === "file" && typeof owner.source?.databaseIdentity === "string") {
          retained = retainPreparedSessionEntryPredicate({
            databaseIdentity: `file:${owner.source.databaseIdentity}`,
            sessionKey: target.storeKey,
            entry: read.value,
            matches: (before, after) =>
              before?.sessionId === after?.sessionId &&
              before?.lifecycleRevision === after?.lifecycleRevision &&
              before?.incognito === after?.incognito,
          });
          unregister = registerOpenClawAgentDatabaseAsyncResource({
            agentId: owner.source.agentId,
            path: owner.source.path,
            revoke: release,
            close: async () => release(),
          });
        }
        return read.value;
      },
    );
    return {
      entry,
      isCurrent: () =>
        active &&
        !options.isStopping() &&
        sessionStorePath() === configuredPath &&
        retained?.isCurrent() === true,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
