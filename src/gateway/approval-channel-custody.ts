import { isDeepStrictEqual } from "node:util";
import type { ApprovalChannelReviewer } from "../../packages/gateway-protocol/src/index.js";
import { isConfiguredCommandOwner } from "../auto-reply/command-auth.js";
import {
  getLoadedChannelPlugin,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { captureMemoryExactSessionReader } from "../config/sessions/session-accessor.memory-exact-read.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../config/sessions/session-accessor.sqlite-scope.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { canChannelEnforcePluginReviewerPolicy } from "../infra/approval-channel-policy-support.js";
import {
  doesApprovalRequestSelectChannelAccountFromDelivery,
  type ApprovalRequestSessionDelivery,
  type ApprovalRequestLike,
} from "../infra/approval-request-account-binding.js";
import { isPluginApprovalRequest, type ChannelApprovalKind } from "../infra/approval-types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

type PreparedApprovalChannelCustody = {
  resolverId: string;
  authorizes: (request: ApprovalRequestLike) => Promise<boolean>;
  isCurrent: (request: ApprovalRequestLike) => boolean;
  [Symbol.dispose]: () => void;
};

function sameDelivery(
  before: Pick<SessionEntry, "sessionId" | "delivery"> | undefined,
  after: Pick<SessionEntry, "sessionId" | "delivery"> | undefined,
) {
  return (
    before?.sessionId === after?.sessionId && isDeepStrictEqual(before?.delivery, after?.delivery)
  );
}

export function prepareApprovalChannelCustody(params: {
  cfg: OpenClawConfig;
  getCfg?: () => OpenClawConfig;
  assertCurrent?: () => void;
  approvalKind: ChannelApprovalKind;
  reviewer: ApprovalChannelReviewer;
}): PreparedApprovalChannelCustody | null {
  const channel = params.reviewer.channel.trim().toLowerCase();
  const accountId = params.reviewer.accountId.trim();
  const senderId = params.reviewer.senderId.trim();
  if (!channel || !accountId || !senderId) {
    return null;
  }
  const plugin = getLoadedChannelPlugin(channel);
  const capability = resolveChannelApprovalCapability(plugin);
  if (
    params.approvalKind === "plugin" &&
    !canChannelEnforcePluginReviewerPolicy(params.cfg, channel, capability)
  ) {
    return null;
  }
  const authorizeActorAction =
    capability?.authorizeActorActionAsync ?? capability?.authorizeActorAction;
  const configCurrent = () =>
    (!params.getCfg || params.getCfg() === params.cfg) &&
    getLoadedChannelPlugin(channel) === plugin;
  if (!authorizeActorAction) {
    if (
      params.approvalKind !== "system-agent" ||
      !isConfiguredCommandOwner(params.cfg, { channel, accountId, senderId })
    ) {
      return null;
    }
    return {
      resolverId: `${channel}:${accountId}`,
      authorizes: async () => configCurrent(),
      isCurrent: configCurrent,
      [Symbol.dispose]() {},
    };
  }
  if (!plugin || !plugin.config.listAccountIds(params.cfg).includes(accountId)) {
    return null;
  }
  const prepared = new Map<
    ApprovalRequestLike,
    {
      authorized: boolean;
      isCurrent: () => boolean;
      release: () => void;
    }
  >();
  let active = true;
  const assertCurrent = () => {
    params.assertCurrent?.();
    if (!active || !configCurrent()) {
      throw new Error("approval reviewer policy changed during preparation");
    }
  };
  return {
    resolverId: `${channel}:${accountId}`,
    async authorizes(request) {
      const existing = prepared.get(request);
      if (existing) {
        return active && configCurrent() && existing.authorized && existing.isCurrent();
      }
      assertCurrent();
      const sessionKey = request.request.sessionKey?.trim() ?? "";
      const agentId =
        parseAgentSessionKey(sessionKey)?.agentId ?? request.request.agentId ?? "main";
      let delivery: ApprovalRequestSessionDelivery | null = null;
      let isCurrent = () => true;
      let release = () => {};
      const memory =
        sessionKey &&
        captureMemoryExactSessionReader(
          {
            sessionKey,
            agentId,
            storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
          },
          assertCurrent,
        );
      try {
        if (memory) {
          const entry = memory.read(sessionKey, "list");
          delivery = entry ?? null;
          isCurrent = () => sameDelivery(entry, memory.read(sessionKey, "list"));
        } else if (
          sessionKey &&
          (!request.request.turnSourceAccountId ||
            (request.request.turnSourceChannel &&
              request.request.turnSourceChannel.trim().toLowerCase() !== channel))
        ) {
          const scope = {
            agentId,
            storePath: resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
            sessionKey,
            projection: "list" as const,
            hydrateSkillPromptRefs: false,
          };
          await withSessionEntryReadOnlyInWorker(scope, assertCurrent, async (read, owner) => {
            if (!read.ok) {
              throw read.error;
            }
            delivery = read.value ?? null;
            if (owner.source) {
              const retained = retainPreparedSessionEntryPredicate({
                databaseIdentity: `file:${owner.source.databaseIdentity}`,
                sessionKey: resolveSqliteSessionKey(sessionKey, agentId),
                entry: read.value,
                matches: sameDelivery,
              });
              isCurrent = retained.isCurrent;
              release = retained.release;
            }
          });
        }
        const pluginRequest =
          params.approvalKind === "plugin" && isPluginApprovalRequest(request)
            ? request
            : undefined;
        const accountIds = plugin.config.listAccountIds(params.cfg);
        const eligibleAccountIds =
          params.approvalKind === "plugin" && !pluginRequest
            ? []
            : (
                await Promise.all(
                  accountIds.map(async (candidateAccountId) => {
                    const result = await authorizeActorAction({
                      cfg: params.cfg,
                      accountId: candidateAccountId,
                      senderId,
                      action: "approve",
                      approvalKind: params.approvalKind,
                      ...(pluginRequest ? { request: pluginRequest } : {}),
                      sessionDelivery: delivery,
                    });
                    return result.authorized ? candidateAccountId : undefined;
                  }),
                )
              ).filter((value): value is string => value !== undefined);
        assertCurrent();
        const authorized =
          eligibleAccountIds.includes(accountId) &&
          doesApprovalRequestSelectChannelAccountFromDelivery(
            {
              cfg: params.cfg,
              request,
              channel,
              accountId,
              defaultAccountId: plugin.config.defaultAccountId?.(params.cfg) ?? "",
              eligibleAccountIds,
            },
            delivery,
          );
        prepared.set(request, { authorized, isCurrent, release });
        return authorized && isCurrent();
      } catch (error) {
        release();
        throw error;
      }
    },
    isCurrent(request) {
      const state = prepared.get(request);
      return active && configCurrent() && state?.authorized === true && state.isCurrent();
    },
    [Symbol.dispose]() {
      active = false;
      for (const state of prepared.values()) {
        state.release();
      }
      prepared.clear();
    },
  };
}
