import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { resolveSessionWorkStartBlock } from "../../config/sessions/session-work-start.js";
import { createSessionWorkStartChangedError } from "../../config/sessions/work-start-error.js";
import { isSyntheticGatewayCaller } from "../server-methods/gateway-personal-caller.js";
import { readGatewayRequestMutationAuthority } from "../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** Human Talk starts share channel restoration; provider consultations never restore. */
export async function restoreTalkSessionTarget(
  request: GatewayRequestHandlerOptions,
  target: PreparedTalkSessionTarget,
  replacementSource?: SessionSourceAssertion,
): Promise<void> {
  const { client, context, sessionMutationAuthorization } = request;
  const requester = readGatewayRequestMutationAuthority(request);
  const scope = {
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  };
  const entry = await readSessionEntryReadOnlyInWorker(scope, requester.assertPreparationCurrent);
  if (entry?.archivedAt === undefined) {
    return;
  }
  const assertCurrent = composeSessionSourceAssertion(
    [requester.assertCurrent, sessionMutationAuthorization?.assertCurrent, replacementSource],
    (assertSources) => {
      assertSources();
      target.assertCurrent(context.getRuntimeConfig());
      if (!client?.connId || isSyntheticGatewayCaller(client)) {
        throw new Error(
          "Archived Talk sessions require a human to restore them in chat or start Talk from a connected client.",
        );
      }
    },
  );
  assertCurrent();
  const { restoreArchivedSession } = await import("../../sessions/session-archive-restore.js");
  await restoreArchivedSession({
    ...scope,
    entry,
    assertCurrent,
    placementContext: context,
  });
  const restored = await readSessionEntryReadOnlyInWorker(scope, assertCurrent);
  if (restored?.lifecycleRevision !== entry.lifecycleRevision) {
    throw createSessionWorkStartChangedError(target.canonicalKey);
  }
  const blocked = resolveSessionWorkStartBlock(target.canonicalKey, restored, {
    expectedSessionId: entry.sessionId,
  });
  if (blocked) {
    throw blocked;
  }
}
