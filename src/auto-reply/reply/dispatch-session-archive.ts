import type { SessionEntry } from "../../config/sessions/types.js";
import { SessionWorkStartChangedError } from "../../config/sessions/work-start-error.js";
import type { SessionWorkerPlacementContext } from "../../gateway/worker-environments/session-placement-lifecycle.js";
import { restoreArchivedSession } from "../../sessions/session-archive-restore.js";
import { classifySessionStateActor } from "../../sessions/session-state-events.js";
import { isNativeCommandTurn } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";

export async function restoreArchivedDispatchSession(params: {
  assertCurrent: () => void;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  hasPluginOwnedBinding: boolean;
  placementContext?: SessionWorkerPlacementContext;
  sessionKey?: string;
  storePath?: string;
}): Promise<SessionEntry | undefined> {
  const { ctx, entry, hasPluginOwnedBinding, sessionKey, storePath } = params;
  if (
    !entry ||
    !sessionKey ||
    !storePath ||
    entry.archivedAt === undefined ||
    hasPluginOwnedBinding ||
    ctx.InboundAccessAuthorized !== true ||
    ctx.InboundEventKind === "room_event" ||
    isNativeCommandTurn(ctx.CommandTurn) ||
    classifySessionStateActor({ inputProvenance: ctx.InputProvenance }).actorType !== "human"
  ) {
    return entry;
  }
  try {
    return await restoreArchivedSession({ ...params, entry, sessionKey, storePath });
  } catch (error) {
    if (error instanceof SessionWorkStartChangedError) {
      throw new DispatchSessionRefreshRequiredError(error);
    }
    throw error;
  }
}
