import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { trackBackgroundSessionCompletion } from "../../app/background-session-tracker.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  autoPromptNotificationsOnSend,
  hasActiveNotificationPromptGesture,
  shouldAutoPromptNotificationsOnSend,
} from "../../app/notifications-auto-prompt.ts";
import { captureSessionNoticeOwner } from "../../app/session-notice-owner.ts";
import { parseSlashCommand } from "../../lib/chat/commands.ts";

type AgentWaitResult = {
  status?: "error" | "ok" | "pending" | "timeout";
  endedAt?: number;
  error?: string;
  pendingError?: boolean;
  providerStarted?: boolean;
  stopReason?: string;
  yielded?: boolean;
};

const RETRY_DELAY_MS = 1_000;

const delayRetry = () =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, RETRY_DELAY_MS);
  });

async function notifyWhenBackgroundSessionEnds(params: {
  agentId: string;
  client: GatewayBrowserClient;
  context: ApplicationContext;
  key: string;
  runId: string;
  isCurrentOwner: () => boolean;
}): Promise<void> {
  const tracker = trackBackgroundSessionCompletion({
    context: params.context,
    client: params.client,
    agentId: params.agentId,
    sessionKey: params.key,
    runId: params.runId,
  });
  let result: AgentWaitResult | undefined;
  while (!result) {
    if (!tracker.current()) {
      tracker.cancel();
      return;
    }
    try {
      const observed = await params.client.request<AgentWaitResult>(
        "agent.wait",
        { runId: params.runId, timeoutMs: 30_000 },
        { timeoutMs: null },
      );
      if (!tracker.current()) {
        tracker.cancel();
        return;
      }
      const observationalTimeout =
        observed.status === "timeout" &&
        observed.endedAt === undefined &&
        !observed.error &&
        !observed.stopReason &&
        observed.providerStarted !== true;
      if (observed.status === "pending" || observed.pendingError === true) {
        await delayRetry();
      } else if (observationalTimeout) {
        // Startup display errors can mean unconfirmed delivery, not a failed run.
        const initialTurn = params.context.placementStartup.get(params.key)?.initialTurn;
        if (initialTurn?.sendState === "failed" && initialTurn.sendRunId === params.runId) {
          result = { status: "error", error: initialTurn.sendError };
        } else {
          // A wait deadline is not a run outcome, even after startup custody retires.
          await delayRetry();
        }
      } else {
        result = observed;
      }
    } catch {
      const gateway = params.context.gateway.snapshot;
      const reconnecting =
        gateway.phase === "connecting" ||
        gateway.phase === "starting" ||
        gateway.phase === "reconnecting";
      if (!tracker.current() || gateway.client !== params.client || !reconnecting) {
        tracker.cancel();
        return;
      }
      await delayRetry();
    }
  }

  if (!params.isCurrentOwner()) {
    tracker.cancel();
    return;
  }

  // Keep explicit background intent until the parent settles after child work.
  if (result.yielded === true) {
    tracker.yield();
    return;
  }
  const notice = {
    sessionKey: params.key,
    agentId: params.agentId,
    runId: params.runId,
    status:
      result.status === "ok"
        ? ("ok" as const)
        : result.status === "timeout"
          ? ("timeout" as const)
          : result.stopReason === "rpc"
            ? ("aborted" as const)
            : ("error" as const),
  };
  tracker.finish(notice);
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
    void notifyWhenBackgroundSessionEnds({
      agentId: params.agentId,
      client: params.client,
      context: params.context,
      key,
      runId: normalizedRunId,
      isCurrentOwner,
    });
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
