import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../auto-reply/reply/session-hooks.js";
import type { SessionEntry } from "../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import {
  emitSessionAutoResetHook,
  hasSessionAutoResetListeners,
  isSessionAutoResetReason,
} from "../hooks/session-auto-reset.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { SessionEndTranscriptSource } from "../plugins/session-end-transcript.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "./active-sessions-shutdown-tracker.js";
import { createArchivedSessionTranscriptSource } from "./session-end-transcript-reader.js";
import { readGatewayBeforeResetPluginHookMessages } from "./session-reset-transcript.js";
import {
  resolveSessionTranscriptCandidates,
  resolveStableSessionEndTranscript,
  type ArchivedSessionTranscript,
} from "./session-transcript-files.fs.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export async function emitGatewayBeforeResetPluginHook(params: {
  cfg: OpenClawConfig;
  key: string;
  messages?: unknown[];
  target: GatewaySessionStoreTarget;
  storePath: string;
  entry?: SessionEntry;
  reason: "new" | "reset";
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_reset")) {
    return;
  }

  const sessionKey = params.target.canonicalKey;
  const sessionId = params.entry?.sessionId;
  const agentId = params.target.agentId;
  const sessionFile = sessionId
    ? formatSqliteSessionFileMarker({ agentId, sessionId, storePath: params.storePath })
    : undefined;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
  const messages =
    params.messages ??
    (await readGatewayBeforeResetPluginHookMessages({
      agentId,
      entry: params.entry,
      sessionId,
      sessionKey,
      storePath: params.storePath,
    }));

  void hookRunner
    .runBeforeReset(
      {
        sessionFile,
        messages,
        reason: params.reason,
      },
      {
        agentId,
        sessionKey,
        sessionId,
        workspaceDir,
      },
    )
    .catch((err: unknown) => {
      logVerbose(`before_reset hook failed: ${String(err)}`);
    });
}

export function emitGatewaySessionEndPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
  workspaceDir?: string;
  reason:
    | "new"
    | "reset"
    | "idle"
    | "daily"
    | "compaction"
    | "deleted"
    | "shutdown"
    | "restart"
    | "unknown";
  archivedTranscripts?: ArchivedSessionTranscript[];
  nextSessionId?: string;
  nextSessionKey?: string;
  endedTranscript?: SessionEndTranscriptSource;
}): void {
  if (!params.sessionId) {
    return;
  }
  // Closing through any lifecycle prevents the shutdown finalizer from firing twice.
  forgetActiveSessionForShutdown(params.sessionId);
  const hookRunner = getGlobalHookRunner();
  const shouldEmitAutoReset =
    isSessionAutoResetReason(params.reason) && hasSessionAutoResetListeners();
  const shouldEmitPluginHook = hookRunner?.hasHooks("session_end") === true;
  if (!shouldEmitAutoReset && !shouldEmitPluginHook) {
    return;
  }
  const archiveCandidates = new Set(
    resolveSessionTranscriptCandidates(
      params.sessionId,
      params.storePath,
      params.sessionFile,
      params.agentId,
    ).map((candidate) => path.resolve(candidate)),
  );
  const endedArchive = params.archivedTranscripts?.find((archive) =>
    archiveCandidates.has(path.resolve(archive.sourcePath)),
  );
  const transcript = resolveStableSessionEndTranscript({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
    archivedTranscripts: endedArchive ? [endedArchive] : params.archivedTranscripts,
  });
  const hookParams = {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    reason: params.reason,
    sessionFile: transcript.sessionFile,
    transcriptArchived: transcript.transcriptArchived,
    nextSessionId: params.nextSessionId,
    nextSessionKey: params.nextSessionKey,
  };
  if (shouldEmitAutoReset) {
    emitSessionAutoResetHook({
      cfg: params.cfg,
      ...hookParams,
      workspaceDir: params.workspaceDir,
      storePath: params.storePath,
    });
  }
  if (!shouldEmitPluginHook || !hookRunner) {
    return;
  }
  const endedTranscript =
    params.endedTranscript ??
    (params.reason === "deleted"
      ? endedArchive
        ? createArchivedSessionTranscriptSource({
            archivedPath: endedArchive.archivedPath,
            agentId: params.agentId,
            sessionId: params.sessionId,
            storePath: params.storePath,
          })
        : { available: false as const, reason: "archive-unavailable" as const }
      : params.reason === "new"
        ? { available: false as const, reason: "no-stable-cutoff" as const }
        : { available: false as const, reason: "unsupported-source" as const });
  const payload = buildSessionEndHookPayload({ ...hookParams, endedTranscript });
  void runWithGatewayDetachedWorkContinuation(async () => {
    await hookRunner.runSessionEnd(payload.event, payload.context);
  }, "hooks:session-end").catch((err: unknown) => {
    logVerbose(`session_end hook failed: ${String(err)}`);
  });
}

export function emitGatewaySessionStartPluginHook(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId?: string;
  resumedFrom?: string;
  storePath?: string;
  sessionFile?: string;
  agentId: string;
}): void {
  if (!params.sessionId) {
    return;
  }
  if (params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("session_start")) {
    return;
  }
  const payload = buildSessionStartHookPayload({ ...params, sessionId: params.sessionId });
  void runWithGatewayDetachedWorkContinuation(async () => {
    await hookRunner.runSessionStart(payload.event, payload.context);
  }, "hooks:session-start").catch((err: unknown) => {
    logVerbose(`session_start hook failed: ${String(err)}`);
  });
}
