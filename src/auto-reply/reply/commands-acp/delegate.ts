// Hub-delegated ACP slash commands for operator list/close/status.
import {
  isHubDelegatedAcpSessionEntry,
  isHubDelegatedOwnedByRequester,
  resolveHubDelegatedAcpPolicy,
  resolveHubDelegatedExpiryPreview,
} from "@openclaw/acp-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import type { AcpCloseSessionResult } from "../../../acp/control-plane/manager.types.js";
import { closeHubDelegatedAcpWorker } from "../../../acp/hub-delegated-lifecycle.js";
import { listAcpSessionEntries } from "../../../acp/runtime/session-meta.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../../agents/tools/sessions-helpers.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { SessionBindingRecord } from "../../../infra/outbound/session-binding.types.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import { collectAcpErrorText, stopWithText } from "./shared.js";

const ACP_DELEGATE_USAGE =
  "Usage: /acp delegate list | /acp delegate close <label> | /acp delegate status <label>";

type DelegateAction = "list" | "close" | "status" | "help";

function resolveDelegateAction(tokens: string[]): DelegateAction {
  const action = normalizeOptionalString(tokens[0])?.toLowerCase();
  if (action === "list" || action === "close" || action === "status") {
    tokens.shift();
    return action;
  }
  return "help";
}

function resolveRequesterInternalKey(params: HandleCommandsParams): string | undefined {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  if (!params.sessionKey) {
    return undefined;
  }
  return resolveInternalSessionKey({
    key: params.sessionKey,
    alias,
    mainKey,
  });
}

async function listOwnedHubDelegates(params: HandleCommandsParams) {
  const requesterKey = resolveRequesterInternalKey(params);
  if (!requesterKey) {
    return undefined;
  }
  const policy = resolveHubDelegatedAcpPolicy(params.cfg.acp?.delegate);
  const allEntries = await listAcpSessionEntries({ cfg: params.cfg });
  const entries = allEntries.filter((entry) =>
    isHubDelegatedOwnedByRequester({
      entry: entry.entry,
      requesterSessionKey: requesterKey,
    }),
  );
  return { requesterKey, policy, entries };
}

function formatDelegateLine(params: {
  sessionKey: string;
  label: string;
  agent: string;
  state: string;
  idleExpiresAt?: number;
  maxAgeExpiresAt?: number;
}): string {
  const expiryParts = [
    params.idleExpiresAt
      ? `idle-expires:${new Date(params.idleExpiresAt).toISOString()}`
      : undefined,
    params.maxAgeExpiresAt
      ? `max-age-expires:${new Date(params.maxAgeExpiresAt).toISOString()}`
      : undefined,
  ].filter(Boolean);
  const expiryText = expiryParts.length > 0 ? `, ${expiryParts.join(", ")}` : "";
  return `- ${params.label} (${params.agent}, ${params.state}) -> ${params.sessionKey}${expiryText}`;
}

export async function handleAcpDelegateAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const action = resolveDelegateAction(restTokens);
  if (action === "help") {
    return stopWithText(ACP_DELEGATE_USAGE);
  }

  const resolved = await listOwnedHubDelegates(params);
  if (!resolved) {
    return stopWithText("⚠️ Missing session key.");
  }
  const { requesterKey, policy, entries } = resolved;

  if (action === "list") {
    if (entries.length === 0) {
      return stopWithText("ACP hub-delegated sessions:\n-----\n(none)");
    }
    const rows = entries
      .toSorted((a, b) => (b.entry?.updatedAt ?? 0) - (a.entry?.updatedAt ?? 0))
      .map(({ sessionKey, entry, acp }) => {
        if (!entry?.hubDelegated || !acp || !isHubDelegatedAcpSessionEntry(entry)) {
          return "";
        }
        const expiry = resolveHubDelegatedExpiryPreview({
          entry: { hubDelegated: entry.hubDelegated, acp },
          policy,
        });
        return formatDelegateLine({
          sessionKey,
          label: normalizeOptionalString(entry.label) ?? acp.agent,
          agent: acp.agent,
          state: acp.state,
          ...expiry,
        });
      })
      .filter(Boolean);
    return stopWithText(["ACP hub-delegated sessions:", "-----", ...rows].join("\n"));
  }

  const label = normalizeOptionalString(restTokens.join(" "));
  if (!label) {
    return stopWithText(ACP_DELEGATE_USAGE);
  }

  const match = entries.find(
    (entry) => normalizeOptionalString(entry.entry?.label)?.toLowerCase() === label.toLowerCase(),
  );
  if (!match?.entry?.hubDelegated || !match.acp) {
    return stopWithText(`⚠️ No hub-delegated session with label "${label}" for this owner.`);
  }

  if (action === "status") {
    const expiry = resolveHubDelegatedExpiryPreview({
      entry: { hubDelegated: match.entry.hubDelegated, acp: match.acp },
      policy,
    });
    const lines = [
      `Hub-delegated session: ${label}`,
      `Key: ${match.sessionKey}`,
      `Agent: ${match.acp.agent}`,
      `State: ${match.acp.state}`,
      `Owner: ${requesterKey}`,
      ...(expiry.idleExpiresAt
        ? [`Idle expires: ${new Date(expiry.idleExpiresAt).toISOString()}`]
        : []),
      ...(expiry.maxAgeExpiresAt
        ? [`Max age expires: ${new Date(expiry.maxAgeExpiresAt).toISOString()}`]
        : []),
      "Follow up via sessions_send(label=...). Close with /acp delegate close <label>.",
    ];
    return stopWithText(lines.join("\n"));
  }

  const acpManager = getAcpSessionManager();
  try {
    let closed: AcpCloseSessionResult | undefined;
    let removedBindings: SessionBindingRecord[] = [];
    await closeHubDelegatedAcpWorker({
      cfg: params.cfg,
      sessionKey: match.sessionKey,
      storePath: match.storePath,
      storeSessionKey: match.storeSessionKey,
      reason: "manual-delegate-close",
      closeRuntime: async ({ cfg, sessionKey, reason }) => {
        closed = await acpManager.closeSession({
          cfg,
          sessionKey,
          reason,
          allowBackendUnavailable: true,
          clearMeta: true,
        });
      },
      unbind: async ({ targetSessionKey }) => {
        removedBindings = await getSessionBindingService().unbind({
          targetSessionKey,
          reason: "manual",
        });
      },
    });
    const runtimeNotice = closed?.runtimeNotice ? ` (${closed.runtimeNotice})` : "";
    return stopWithText(
      `✅ Closed hub-delegated session "${label}" (${match.sessionKey})${runtimeNotice}. Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    return stopWithText(
      collectAcpErrorText({
        error,
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP delegate close failed before completion.",
      }),
    );
  }
}
