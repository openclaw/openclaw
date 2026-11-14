import { sleepWithAbort } from "@openclaw/retry";
import type { AgentWaitResult } from "../../../../src/agents/run-wait.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  autoPromptNotificationsOnSend,
  hasActiveNotificationPromptGesture,
  shouldAutoPromptNotificationsOnSend,
} from "../../app/notifications-auto-prompt.ts";
import { t } from "../../i18n/index.ts";
import { registerCommandPaletteEnglish } from "../../i18n/locales/en-command-palette.ts";
import { normalizeAgentTargetLabel, resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import type { SessionCreateOutcome } from "../../lib/sessions/create.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  areUiSessionKeysEquivalent,
  uiSessionEventMatches,
} from "../../lib/sessions/session-key.ts";
import { showToast } from "../../lib/toast.ts";
import { captureSessionNoticeOwner, openSessionNoticeTarget } from "./session-notice-owner.ts";

const RETRY_DELAY_MS = 1_000;

/** Both launchers use the same accepted-session notice and recovery destination. */
export function showBackgroundSessionCreated(
  readContext: () => ApplicationContext | undefined,
  result: SessionCreateOutcome & { agentId: string },
  onOpen?: () => void,
) {
  const context = readContext();
  if (!context) {
    return;
  }
  registerCommandPaletteEnglish();
  const isCurrentOwner = captureSessionNoticeOwner(context);
  const message =
    result.initialRun.status === "rejected"
      ? t("palette.sessionCreatedWithError", { error: formatUiError(result.initialRun.error) })
      : t(
          result.initialRun.status === "started"
            ? "palette.sessionStarted"
            : "palette.sessionCreated",
        );
  showToast({
    message,
    dedupeKey: `session-create:${result.agentId}:${result.key}`,
    severity: result.initialRun.status === "rejected" ? "error" : "success",
    actionLabel: t("sessionsView.openSession"),
    onAction: () => {
      if (readContext() !== context || !isCurrentOwner()) {
        return;
      }
      openSessionNoticeTarget(context, result.key, result.agentId);
      onOpen?.();
    },
  });
}

export function prepareBackgroundSessionCompletion(params: {
  enabled: boolean;
  agentId: string;
  client: GatewayBrowserClient;
  context: ApplicationContext;
}): (key: string, runId?: string) => boolean {
  const isCurrentOwner = captureSessionNoticeOwner(params.context);
  return (key, runId) => {
    const normalizedRunId = runId?.trim();
    if (!params.enabled) {
      return false;
    }
    // Creation disposition is independent of whether the Gateway returned a watchable run.
    if (!normalizedRunId) {
      return true;
    }
    const { agentId, client, context } = params;
    void (async () => {
      let result: Partial<AgentWaitResult> | undefined;
      while (!result) {
        try {
          const observed = await client.request<Partial<AgentWaitResult>>(
            "agent.wait",
            { runId: normalizedRunId, timeoutMs: 30_000 },
            { timeoutMs: null },
          );
          if (context.gateway.snapshot.client !== client) {
            return;
          }
          const observationalTimeout =
            observed.status === "timeout" &&
            observed.endedAt === undefined &&
            !observed.error &&
            !observed.stopReason &&
            observed.providerStarted !== true;
          if (observed.status === "pending" || observed.pendingError === true) {
            await sleepWithAbort(RETRY_DELAY_MS);
          } else if (observationalTimeout) {
            // Pending startup delivery is not a failed run.
            const initialTurn = context.placementStartup.get(key)?.initialTurn;
            if (initialTurn?.sendState === "failed" && initialTurn.sendRunId === normalizedRunId) {
              result = { status: "error", error: initialTurn.sendError };
            } else {
              // A wait deadline is not a run outcome, even after startup custody retires.
              await sleepWithAbort(RETRY_DELAY_MS);
            }
          } else {
            result = observed;
          }
        } catch {
          const gateway = context.gateway.snapshot;
          const reconnecting =
            gateway.phase === "connecting" ||
            gateway.phase === "starting" ||
            gateway.phase === "reconnecting";
          if (gateway.client !== client || !reconnecting) {
            return;
          }
          await sleepWithAbort(RETRY_DELAY_MS);
        }
      }

      if (!isCurrentOwner()) {
        return;
      }
      const gateway = context.gateway.snapshot;
      if (uiSessionEventMatches(gateway, key, agentId)) {
        return;
      }
      const row = context.sessions.state.result?.sessions.find((session) =>
        areUiSessionKeysEquivalent(session.key, key),
      );
      // A finished run needs no label; any other outcome names itself in one muted word.
      const status =
        result.status === "ok"
          ? undefined
          : result.status === "timeout"
            ? t("sessionsView.statusTimeout")
            : result.stopReason === "rpc"
              ? t("chat.handoffSessionStatus.stopped")
              : t("sessionsView.statusFailed");
      const nativeTarget = sessionNavigationTarget({
        face: "chat",
        sessionKey: key,
        fallbackAgentId: agentId,
        exactKey: true,
      });
      context.nativeNotifications?.backgroundSessionCompleted({
        runId: normalizedRunId,
        path: nativeTarget.options.pathname,
        ...(nativeTarget.options.search ? { search: nativeTarget.options.search } : {}),
      });
      const agent = context.agents.state.agentsList?.agents.find(
        (entry) => entry.id === agentId,
      ) ?? { id: agentId };
      const identity = context.agentIdentity.get(agentId);
      showToast({
        severity:
          result.status === "ok"
            ? "success"
            : result.status === "timeout"
              ? "error"
              : result.stopReason === "rpc"
                ? undefined
                : "error",
        placement: "top-right",
        avatar: {
          id: agentId,
          name: normalizeAgentTargetLabel(agent, identity),
          avatar: resolveAgentAvatarUrl(agent, identity),
          textAvatar: resolveAgentTextAvatar(agent, identity),
        },
        message: resolveSessionDisplayName(key, row),
        description: status,
        actionLabel: t("sessionsView.openSession"),
        actionHref: sessionNavigationTarget({ context, face: "chat", sessionKey: key, agentId })
          .href,
        onAction: (event) => {
          if (!isCurrentOwner()) {
            event?.preventDefault();
            return;
          }
          const open = () => openSessionNoticeTarget(context, key, agentId);
          if (!event) {
            open();
          } else if (event.type === "click") {
            handleNavigationClick(event, open);
          }
        },
      });
    })();
    return true;
  };
}

/** Keep notification permission on the original input event, before startup awaits. */
export function promptNewSessionNotifications(
  context: ApplicationContext,
  message: string,
  hasAttachments: boolean,
  direct: boolean,
) {
  if (
    shouldAutoPromptNotificationsOnSend({
      connected: context.gateway.snapshot.phase === "connected",
      directComposerSend: direct && hasActiveNotificationPromptGesture(),
      message,
      hasAttachments,
      isCommand: parseSlashCommand(message) !== null,
    })
  ) {
    autoPromptNotificationsOnSend(context);
  }
}
