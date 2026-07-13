import type { SessionEntry } from "../config/sessions/types.js";
import type { PluginRuntime } from "./runtime/types.js";

export const PLUGIN_GATEWAY_SESSION_MUTATION_METHODS = new Set([
  "agent",
  "chat.abort",
  "chat.inject",
  "chat.send",
  "message.action",
  "plugins.sessionAction",
  "send",
  "sessions.abort",
  "sessions.compact",
  "sessions.compaction.branch",
  "sessions.compaction.restore",
  "sessions.create",
  "sessions.delete",
  "sessions.patch",
  "sessions.pluginPatch",
  "sessions.reset",
  "sessions.send",
  "sessions.steer",
  "wake",
]);

export const PLUGIN_GATEWAY_GLOBAL_SESSION_MUTATION_METHODS = new Set([
  "sessions.cleanup",
  "sessions.groups.delete",
  "sessions.groups.rename",
]);

type ResetParams = Parameters<PluginRuntime["agent"]["session"]["resetSessionEntryLifecycle"]>[0];
type ResetContext = {
  agentId?: string;
  entry: SessionEntry;
  reason: "reset";
  sessionFile?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};
type ResetWithOwnerParams = ResetParams & {
  releasePhysicalOwner?: (context: ResetContext) => Promise<void> | void;
};
type LockedHarnessResolution =
  | {
      harnessId?: string;
      ownerPluginId: string;
      registration?: {
        harness: {
          reset?: (params: {
            agentId?: string;
            reason: "reset";
            sessionFile?: string;
            sessionId: string;
            sessionKey: string;
          }) => Promise<void> | void;
        };
      };
    }
  | undefined;

export async function resetPluginSessionEntryLifecycle(params: {
  assertStoredSessionEntryOwned: (params: {
    action: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  }) => SessionEntry | undefined;
  pluginId: string;
  request: ResetParams;
  reset: (params: ResetWithOwnerParams) => Promise<SessionEntry | null>;
  resolveLockedSessionHarnessRegistration: (
    sessionKey: string,
    entry: SessionEntry,
    action: string,
  ) => LockedHarnessResolution;
}): Promise<SessionEntry | null> {
  const request = params.request;
  params.assertStoredSessionEntryOwned({
    action: "reset",
    sessionKey: request.sessionKey,
    ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
    ...(request.env !== undefined ? { env: request.env } : {}),
    ...(request.storePath !== undefined ? { storePath: request.storePath } : {}),
  });
  return await params.reset({
    ...request,
    releasePhysicalOwner: async (context: ResetContext) => {
      const locked = params.resolveLockedSessionHarnessRegistration(
        context.sessionKey,
        context.entry,
        "reset",
      );
      const registration = locked?.registration;
      if (!locked || locked.ownerPluginId !== params.pluginId || !registration) {
        throw new Error(
          `Locked session "${context.sessionKey}" is owned by plugin "${locked?.ownerPluginId ?? "unknown"}", not "${params.pluginId}".`,
        );
      }
      if (!registration.harness.reset) {
        throw new Error(
          `Agent harness "${locked.harnessId}" must implement reset before locked sessions can be reset.`,
        );
      }
      await registration.harness.reset({
        ...(context.agentId !== undefined ? { agentId: context.agentId } : {}),
        reason: context.reason,
        ...(context.sessionFile !== undefined ? { sessionFile: context.sessionFile } : {}),
        sessionId: context.sessionId,
        sessionKey: context.sessionKey,
      });
    },
  });
}
