import { prepareSessionForkFromParent } from "../auto-reply/reply/session-fork.js";
import type { SessionEntry } from "../config/sessions.js";
import { runWithSessionEntryCreationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache.js";
import type { SessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import { buildForkedGatewaySessionEntry } from "./session-create-fork-entry.js";
import { resolveSessionForkMaxTokens } from "./session-create-model-selection.js";
import type {
  CreateGatewaySessionParams,
  PreparedGatewaySessionLifecycle,
} from "./session-create-service.types.js";
import { invalidSessionRequest, unavailableSessionRequest } from "./session-request-error.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

/** Prepare the selected source history under the destination's creation and workspace custody. */
export async function prepareGatewaySessionFork(params: {
  request: Pick<CreateGatewaySessionParams, "cfg" | "forkFrom" | "loadGatewayModelCatalogSnapshot">;
  target: GatewaySessionStoreTarget;
  entry: SessionEntry;
  existingEntry?: SessionEntry;
  parent: { entry: SessionEntry; target: GatewaySessionStoreTarget };
  commitGuard?: () => void;
  withCommit?: PreparedGatewaySessionLifecycle["withCommit"];
  creationOperation?: SessionEntryCreationOperation;
}) {
  const { request, target, parent, commitGuard, creationOperation } = params;
  const maxTokens = await resolveSessionForkMaxTokens({
    cfg: request.cfg,
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    entry: params.entry,
    loadGatewayModelCatalogSnapshot: request.loadGatewayModelCatalogSnapshot,
  });
  // Size admission and copying select the same completed prefix, even with an active tail.
  const forkFromParent = async (assertSourceCurrent?: () => void) =>
    await prepareSessionForkFromParent({
      parentEntry: parent.entry,
      agentId: parent.target.agentId,
      ...(commitGuard || assertSourceCurrent
        ? {
            commitGuard: () => {
              commitGuard?.();
              assertSourceCurrent?.();
            },
          }
        : {}),
      parentSessionKey: parent.target.canonicalKey,
      sessionKey: target.canonicalKey,
      storePath: parent.target.storePath,
      ...(maxTokens ? { maxTokens } : {}),
      // Cross-agent forks still write the transcript into the destination's store.
      targetStorePath: target.storePath,
      ...(request.forkFrom ? { forkFrom: request.forkFrom } : {}),
    });
  const forkWithCreation = (assertSourceCurrent?: () => void) =>
    creationOperation
      ? runWithSessionEntryCreationPublication(creationOperation, () =>
          forkFromParent(assertSourceCurrent),
        )
      : forkFromParent(assertSourceCurrent);
  const fork = params.withCommit
    ? await params.withCommit(forkWithCreation)
    : await forkWithCreation();
  if (fork.status === "too-large") {
    return invalidSessionRequest(
      `parent session is too large to fork (${fork.decision.parentTokens}/${fork.decision.maxTokens} tokens)`,
    );
  }
  if (fork.status !== "prepared") {
    return unavailableSessionRequest("failed to fork parent session transcript");
  }
  return {
    ok: true as const,
    transcriptEvents: fork.events,
    entry: buildForkedGatewaySessionEntry(
      params.entry,
      fork.transcript,
      { sessionKey: parent.target.canonicalKey, entry: parent.entry },
      params.existingEntry,
    ),
  };
}
