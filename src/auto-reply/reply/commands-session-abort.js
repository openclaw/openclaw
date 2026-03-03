import { abortEmbeddedPiRun } from "../../agents/pi-embedded.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { resolveAbortCutoffFromContext, shouldPersistAbortCutoff, } from "./abort-cutoff.js";
import { formatAbortReplyText, isAbortTrigger, resolveSessionEntryForKey, setAbortMemory, stopSubagentsForRequester, } from "./abort.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import { persistAbortTargetEntry } from "./commands-session-store.js";
import { clearSessionQueues } from "./queue.js";
function resolveAbortTarget(params) {
    const targetSessionKey = params.ctx.CommandTargetSessionKey?.trim() || params.sessionKey;
    const { entry, key } = resolveSessionEntryForKey(params.sessionStore, targetSessionKey);
    if (entry && key) {
        return { entry, key, sessionId: entry.sessionId };
    }
    if (params.sessionEntry && params.sessionKey) {
        return {
            entry: params.sessionEntry,
            key: params.sessionKey,
            sessionId: params.sessionEntry.sessionId,
        };
    }
    return { entry: undefined, key: targetSessionKey, sessionId: undefined };
}
function resolveAbortCutoffForTarget(params) {
    if (!shouldPersistAbortCutoff({
        commandSessionKey: params.commandSessionKey,
        targetSessionKey: params.targetSessionKey,
    })) {
        return undefined;
    }
    return resolveAbortCutoffFromContext(params.ctx);
}
async function applyAbortTarget(params) {
    const { abortTarget } = params;
    if (abortTarget.sessionId) {
        abortEmbeddedPiRun(abortTarget.sessionId);
    }
    const persisted = await persistAbortTargetEntry({
        entry: abortTarget.entry,
        key: abortTarget.key,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
        abortCutoff: params.abortCutoff,
    });
    if (!persisted && params.abortKey) {
        setAbortMemory(params.abortKey, true);
    }
}
export const handleStopCommand = async (params, allowTextCommands) => {
    if (!allowTextCommands) {
        return null;
    }
    if (params.command.commandBodyNormalized !== "/stop") {
        return null;
    }
    const unauthorizedStop = rejectUnauthorizedCommand(params, "/stop");
    if (unauthorizedStop) {
        return unauthorizedStop;
    }
    const abortTarget = resolveAbortTarget({
        ctx: params.ctx,
        sessionKey: params.sessionKey,
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
    });
    const cleared = clearSessionQueues([abortTarget.key, abortTarget.sessionId]);
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
        logVerbose(`stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`);
    }
    await applyAbortTarget({
        abortTarget,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
        abortKey: params.command.abortKey,
        abortCutoff: resolveAbortCutoffForTarget({
            ctx: params.ctx,
            commandSessionKey: params.sessionKey,
            targetSessionKey: abortTarget.key,
        }),
    });
    // Trigger internal hook for stop command
    const hookEvent = createInternalHookEvent("command", "stop", abortTarget.key ?? params.sessionKey ?? "", {
        sessionEntry: abortTarget.entry ?? params.sessionEntry,
        sessionId: abortTarget.sessionId,
        commandSource: params.command.surface,
        senderId: params.command.senderId,
    });
    await triggerInternalHook(hookEvent);
    const { stopped } = stopSubagentsForRequester({
        cfg: params.cfg,
        requesterSessionKey: abortTarget.key ?? params.sessionKey,
    });
    return { shouldContinue: false, reply: { text: formatAbortReplyText(stopped) } };
};
export const handleAbortTrigger = async (params, allowTextCommands) => {
    if (!allowTextCommands) {
        return null;
    }
    if (!isAbortTrigger(params.command.rawBodyNormalized)) {
        return null;
    }
    const unauthorizedAbortTrigger = rejectUnauthorizedCommand(params, "abort trigger");
    if (unauthorizedAbortTrigger) {
        return unauthorizedAbortTrigger;
    }
    const abortTarget = resolveAbortTarget({
        ctx: params.ctx,
        sessionKey: params.sessionKey,
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
    });
    await applyAbortTarget({
        abortTarget,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
        abortKey: params.command.abortKey,
        abortCutoff: resolveAbortCutoffForTarget({
            ctx: params.ctx,
            commandSessionKey: params.sessionKey,
            targetSessionKey: abortTarget.key,
        }),
    });
    return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
};
