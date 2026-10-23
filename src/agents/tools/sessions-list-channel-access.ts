import pMap from "p-map";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AgentToAgentPolicy } from "../../plugin-sdk/session-visibility.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import { currentSessionChannelReadAccess } from "./sessions-channel-read-result.js";
import {
  createSessionVisibilityRowChecker,
  resolveDisplaySessionKey,
  resolveSessionToolAccess,
  resolveSessionToolChannelScope,
  type GatewaySessionListRow,
} from "./sessions-helpers.js";

export async function createSessionsListVisibleReference(params: {
  cfg: OpenClawConfig;
  visibility: "self" | "tree" | "channel" | "agent" | "all";
  requesterAgentId: string;
  requesterSessionKey: string;
  mainSessionKey?: string;
  alias: string;
  mainKey: string;
  a2aPolicy: AgentToAgentPolicy;
  callGateway: AgentToolGatewayRequestCaller;
}) {
  const requesterChannelScope = await resolveSessionToolChannelScope({
    visibility: params.visibility,
    sessionKey: params.requesterSessionKey,
    agentId: params.requesterAgentId,
    callGateway: params.callGateway,
  });
  const visibilityGuard = createSessionVisibilityRowChecker({
    requesterChannelScope,
    action: "list",
    defaultAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    mainSessionKey: params.mainSessionKey,
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
  });
  const visibleReference = (key: string, parentSessionKey?: string): string | undefined => {
    if (isIncognitoSessionKey(key)) {
      return undefined;
    }
    try {
      const agentId = resolveSessionToolTargetAgentId({
        cfg: params.cfg,
        targetSessionKey: key,
        requesterAgentId: params.requesterAgentId,
      });
      if (!visibilityGuard.check({ key, agentId, parentSessionKey }).allowed) {
        return undefined;
      }
      return resolveDisplaySessionKey({ key, alias: params.alias, mainKey: params.mainKey });
    } catch {
      return undefined;
    }
  };
  return { visibleReference, visibilityGuard };
}

type SessionCandidate = {
  entry: GatewaySessionListRow;
  agentId: string;
  offset: number;
};

type ChannelAccess = Extract<
  Awaited<ReturnType<typeof resolveSessionToolAccess>>,
  { allowed: true }
>;

export async function prepareSessionsListChannelAccess(params: {
  cfg: OpenClawConfig;
  visibility: "self" | "tree" | "channel" | "agent" | "all";
  sessions: SessionCandidate[];
  requesterAgentId: string;
  requesterSessionKey: string;
  mainSessionKey?: string;
  a2aPolicy: AgentToAgentPolicy;
  callGateway: AgentToolGatewayRequestCaller;
  signal?: AbortSignal;
}) {
  const accessByEntry = new Map<GatewaySessionListRow, ChannelAccess>();
  const sessions =
    params.visibility === "channel"
      ? (
          await pMap(
            params.sessions,
            async (candidate) => {
              const access = await resolveSessionToolAccess({
                action: "history",
                displayAction: "list",
                requesterAgentId: params.requesterAgentId,
                requesterSessionKey: params.requesterSessionKey,
                mainSessionKey: params.mainSessionKey,
                targetAgentId: candidate.agentId,
                targetSessionKey: candidate.entry.key,
                requesterOwned: false,
                visibility: params.visibility,
                a2aPolicy: params.a2aPolicy,
                callGateway: params.callGateway,
              });
              if (!access.allowed) {
                return undefined;
              }
              accessByEntry.set(candidate.entry, access);
              return candidate;
            },
            { concurrency: 4, stopOnError: true },
          )
        ).filter((candidate): candidate is SessionCandidate => candidate !== undefined)
      : params.sessions;

  return {
    sessions,
    runWithCurrentAccess: async <T>(
      entry: GatewaySessionListRow,
      agentId: string,
      run: () => Promise<T>,
    ): Promise<T> => {
      const access = accessByEntry.get(entry);
      return access
        ? await runWithScopedSessionAccess({
            cfg: params.cfg,
            agentId,
            expectedSessionId: access.expectedSessionId,
            revalidateCurrent: access.revalidateCurrent,
            admissionIdentities: access.admissionIdentities,
            ...(params.signal ? { signal: params.signal } : {}),
            targetSessionKey: entry.key,
            run,
          })
        : await run();
    },
    revalidateCurrent: async (entry: GatewaySessionListRow): Promise<boolean> => {
      try {
        await accessByEntry.get(entry)?.revalidateCurrent?.();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Apply channel and existing row-owner checks in the same synchronous publication. */
export async function finalizeSessionsListChannelRead<T>(params: {
  sessions: readonly SessionCandidate[];
  channelAccess: Awaited<ReturnType<typeof prepareSessionsListChannelAccess>>;
  visibility: "self" | "tree" | "channel" | "agent" | "all";
  requesterAgentId: string;
  requesterSessionKey: string;
  sandboxed: boolean;
  a2aPolicy: AgentToAgentPolicy;
  allowArchivedMetadata: boolean;
  requireSessionReadOwner: boolean;
  hasEnrichment: boolean;
  finalize: (visible: readonly boolean[]) => T;
}): Promise<T> {
  const channelVisible = await pMap(
    params.sessions,
    ({ entry }) => params.channelAccess.revalidateCurrent(entry),
    { concurrency: 4, stopOnError: true },
  );
  const channelRead = {
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    sandboxed: params.sandboxed,
    a2aPolicy: params.a2aPolicy,
    allowArchivedMetadata: params.allowArchivedMetadata,
    targets: params.sessions.map(({ entry, agentId: sessionAgentId }) => ({
      key: entry.key,
      agentId: sessionAgentId,
      expectedSessionId: entry.sessionId,
    })),
  };
  if (!params.requireSessionReadOwner && !params.hasEnrichment) {
    const currentVisible =
      params.visibility === "channel"
        ? currentSessionChannelReadAccess(channelRead)
        : channelVisible;
    return params.finalize(
      currentVisible.map((visible, index) => visible && channelVisible[index] === true),
    );
  }
  const { withCurrentSessionListRows } = await import("../../gateway/session-list-read-result.js");
  return withCurrentSessionListRows(
    params.sessions.map(({ entry }) => entry),
    (ownerVisible, read) => {
      const currentVisible =
        params.visibility === "channel"
          ? currentSessionChannelReadAccess(channelRead, read)
          : channelVisible;
      return params.finalize(
        ownerVisible.map(
          (visible, index) =>
            visible && channelVisible[index] === true && currentVisible[index] === true,
        ),
      );
    },
    params.requireSessionReadOwner,
    params.visibility === "channel"
      ? [{ key: params.requesterSessionKey, agentId: params.requesterAgentId }]
      : [],
  );
}
