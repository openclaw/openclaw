import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveTrustedGroupId } from "../../agents/agent-tools.policy.js";
import type {
  SubagentAdmissionRejection,
  SubagentSessionEffects,
} from "../../agents/subagents/registry/subagent-registry.types.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import type { SessionEntryCurrentFacts } from "../../config/sessions/session-entry-current.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import type { GatewayContextResolver } from "./types.js";

export type TrustedGroupMetadata = {
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

export function normalizeTrustedGroupMetadata(value?: {
  groupId?: unknown;
  groupChannel?: unknown;
  groupSpace?: unknown;
  space?: unknown;
}): TrustedGroupMetadata {
  return {
    groupId: normalizeOptionalString(value?.groupId),
    groupChannel: normalizeOptionalString(value?.groupChannel),
    groupSpace: normalizeOptionalString(value?.groupSpace ?? value?.space),
  };
}

function resolveSessionKeyGroupId(sessionKey: string): string | undefined {
  const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
  const conversation = parseRawSessionConversationRef(baseSessionKey ?? sessionKey);
  if (!conversation || (conversation.kind !== "group" && conversation.kind !== "channel")) {
    return undefined;
  }
  return conversation.rawId;
}

function resolveTrustedGroupMetadata(params: {
  sessionKey: string;
  spawnedBy?: string;
  stored: TrustedGroupMetadata;
  inherited?: TrustedGroupMetadata;
}): TrustedGroupMetadata {
  return {
    // Group trust can be inherited from the parent run or recovered from conversation-shaped keys.
    groupId:
      params.stored.groupId ??
      params.inherited?.groupId ??
      resolveSessionKeyGroupId(params.sessionKey) ??
      (params.spawnedBy ? resolveSessionKeyGroupId(params.spawnedBy) : undefined),
    groupChannel: params.stored.groupChannel ?? params.inherited?.groupChannel,
    groupSpace: params.stored.groupSpace ?? params.inherited?.groupSpace,
  };
}

export function resolveAgentSessionGroup(params: {
  sessionKey: string;
  spawnedBy?: string;
  stored: TrustedGroupMetadata;
  inherited?: TrustedGroupMetadata;
  requested: TrustedGroupMetadata;
}): {
  groupId: string | undefined;
  groupChannel: string | undefined;
  groupSpace: string | undefined;
} {
  const trusted = resolveTrustedGroupMetadata(params);
  const validated = trusted.groupId
    ? resolveTrustedGroupId({
        groupId: trusted.groupId,
        sessionKey: params.sessionKey,
        spawnedBy: params.spawnedBy,
      })
    : undefined;
  const trustSelectors =
    Boolean(trusted.groupId) &&
    requestGroupMatchesTrusted({
      requestGroupId: params.requested.groupId,
      trustedGroupId: trusted.groupId,
    });
  return validated?.dropped
    ? { groupId: undefined, groupChannel: undefined, groupSpace: undefined }
    : {
        groupId: trusted.groupId,
        groupChannel:
          trusted.groupChannel ?? (trustSelectors ? params.requested.groupChannel : undefined),
        groupSpace:
          trusted.groupSpace ?? (trustSelectors ? params.requested.groupSpace : undefined),
      };
}

function requestGroupMatchesTrusted(params: {
  requestGroupId?: string;
  trustedGroupId?: string;
}): boolean {
  const requestGroupId = params.requestGroupId?.trim();
  if (!requestGroupId) {
    // Missing group metadata is accepted so non-group channels keep the same send path.
    return true;
  }
  return Boolean(params.trustedGroupId && requestGroupId === params.trustedGroupId);
}

type AdmittedPluginSession = {
  sessionId: string;
  storePath: string;
  entry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
};

async function capturePluginSubagentSessionEffects(params: {
  childAgentId: string;
  childSessionKey: string;
  admitted: AdmittedPluginSession;
  assertCurrent: () => void;
}): Promise<SubagentSessionEffects> {
  const { sessionId: admittedSessionId, storePath } = params.admitted;
  // Admission may rotate the id after persistence; only its matching snapshot owns a revision.
  const expected =
    params.admitted.entry?.sessionId === admittedSessionId
      ? { lifecycleRevision: params.admitted.entry.lifecycleRevision }
      : undefined;
  const [{ captureSessionEntryCurrentRead }, { withSessionEntryReadOnlyInWorker }] =
    await Promise.all([
      import("../../config/sessions/session-entry-current-runtime.js"),
      import("../../config/sessions/session-entry-read-runtime.js"),
    ]);
  params.assertCurrent();
  const scope = {
    agentId: params.childAgentId,
    storePath,
    sessionKey: params.childSessionKey,
    sessionId: admittedSessionId,
  };
  const effects = await withSessionEntryReadOnlyInWorker(
    scope,
    params.assertCurrent,
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      const entry = read.value;
      if (
        entry?.sessionId !== admittedSessionId ||
        (expected && entry.lifecycleRevision !== expected.lifecycleRevision)
      ) {
        throw new Error("Plugin subagent session changed before registration.");
      }
      const { sessionId, lifecycleRevision, lifecycleRunId, activeWriterRunId } = entry;
      const currentRead = captureSessionEntryCurrentRead(scope, owner);
      const assertCurrentEntry = (current: SessionEntryCurrentFacts | undefined) => {
        currentRead.assertSourceCurrent();
        if (
          current?.sessionId !== sessionId ||
          current.lifecycleRevision !== lifecycleRevision ||
          current.lifecycleRunId !== lifecycleRunId ||
          current.activeWriterRunId !== activeWriterRunId
        ) {
          throw new Error("Plugin subagent child session owner changed.");
        }
      };
      params.assertCurrent();
      return {
        async isCurrent() {
          try {
            assertCurrentEntry(await currentRead.readCurrent());
            return true;
          } catch {
            return false;
          }
        },
        assertHostCurrent() {
          currentRead.assertSourceCurrent();
          if (!currentRead.source) {
            assertCurrentEntry(currentRead.readCurrent());
          }
        },
        assertCurrentEntry,
        ...(currentRead.source
          ? { nativeCheck: { source: currentRead.source, assertCurrent: assertCurrentEntry } }
          : {}),
      };
    },
  );
  params.assertCurrent();
  effects.assertHostCurrent();
  return effects;
}

export async function registerPluginSubagentRunFromGateway(params: {
  cfg: OpenClawConfig;
  runId: string;
  childSessionKey: string;
  childAgentId: string;
  task: string;
  requester?: PluginSubagentRequesterContext;
  pluginId?: string;
  gatewayContextResolver?: GatewayContextResolver;
  assertCurrent: () => SessionEntry | undefined;
  retainAdmission?: (reject: SubagentAdmissionRejection) => void;
  admittedSession?: AdmittedPluginSession;
}): Promise<void> {
  const { childSessionKey } = params;
  const ownerSessionKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.childAgentId,
  });
  const requesterSessionKey = params.requester?.sessionKey ?? ownerSessionKey;
  const {
    adoptPausedSubagentRunForFollowUp,
    adoptPausedSubagentRunIntoSuccessor,
    registerSubagentRun,
  } = await import("../../agents/subagents/registry/subagent-registry.js");
  const sessionEntry = params.assertCurrent();
  let admissionSessionEffects: SubagentSessionEffects | undefined;
  if (params.retainAdmission) {
    if (!params.admittedSession) {
      throw new Error("Plugin subagent rejection cleanup requires its admitted session.");
    }
    admissionSessionEffects = await capturePluginSubagentSessionEffects({
      childAgentId: params.childAgentId,
      childSessionKey,
      admitted: params.admittedSession,
      assertCurrent: params.assertCurrent,
    });
    params.assertCurrent();
  }
  // Resume a yielded run with its original audience unless the follow-up names
  // a requester and therefore owns a separate delivery. Recheck after sibling
  // registration in case the pause publishes while admission is in flight.
  if (
    !params.requester &&
    (await adoptPausedSubagentRunForFollowUp({
      childSessionKey,
      childAgentId: params.childAgentId,
      runId: params.runId,
      task: params.task,
      gatewayContextResolver: params.gatewayContextResolver,
      assertCurrent: params.assertCurrent,
      retainAdmission: params.retainAdmission,
      admissionSessionEffects,
    }))
  ) {
    return;
  }
  await registerSubagentRun(
    {
      runId: params.runId,
      childSessionKey,
      childAgentId: params.childAgentId,
      sessionEntry,
      controllerSessionKey: ownerSessionKey,
      requesterSessionKey,
      requesterOrigin: params.requester?.origin,
      requesterDisplayKey: params.requester ? requesterSessionKey : "main",
      task: params.task,
      cleanup: "keep",
      ...(params.pluginId ? { label: `plugin:${params.pluginId}` } : {}),
      expectsCompletionMessage: params.requester !== undefined,
      spawnMode: "run",
      gatewayContextResolver: params.gatewayContextResolver,
    },
    {
      assertCurrent: params.assertCurrent,
      retainAdmission: params.retainAdmission,
      admissionSessionEffects,
    },
  );
  if (!params.requester) {
    await adoptPausedSubagentRunIntoSuccessor({
      childSessionKey,
      childAgentId: params.childAgentId,
      assertCurrent: params.assertCurrent,
      retainAdmission: params.retainAdmission,
      admissionSessionEffects,
    });
  }
}
