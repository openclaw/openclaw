import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { parseLogsPositiveInt } from "../../cli/logs-cli.options.js";
import { formatDurationHuman } from "../../infra/format-time/format-duration.js";
import { defaultRuntime } from "../../runtime.js";

type ChannelsDeadLettersOptions = {
  channel?: string;
  account?: string;
  limit?: string | number;
  json?: boolean;
};

function resolveScope(options: ChannelsDeadLettersOptions) {
  const channelId = options.channel?.trim();
  if (!channelId) {
    throw new Error("--channel is required.");
  }
  // Only omission selects the default queue; an explicit blank selector must not change scope.
  const accountId = options.account?.trim() ?? "default";
  if (!accountId) {
    throw new Error("--account must not be blank");
  }
  return { channelId, accountId };
}

export async function channelsDeadLettersListCommand(
  options: ChannelsDeadLettersOptions,
): Promise<void> {
  const { channelId, accountId } = resolveScope(options);
  const queue = createChannelIngressQueue({ channelId, accountId });
  if (!queue.listFailed) {
    throw new Error("This runtime does not support channel ingress dead-letter inspection.");
  }
  const deadLetters = await queue.listFailed({
    limit: parseLogsPositiveInt(options.limit, 100, "--limit"),
  });
  if (options.json) {
    defaultRuntime.writeJson({ channelId, accountId, deadLetters });
    return;
  }
  defaultRuntime.log(
    theme.heading(terminalText`Channel ingress dead letters (${channelId}/${accountId})`),
  );
  if (deadLetters.length === 0) {
    defaultRuntime.log(theme.muted("No dead-lettered ingress events."));
    return;
  }
  const now = Date.now();
  for (const entry of deadLetters) {
    const age = formatDurationHuman(Math.max(0, now - entry.failedAt));
    defaultRuntime.log(
      terminalText`- ${entry.id}: ${entry.reason}; attempts=${entry.attempts}; failed ${age} ago`,
    );
  }
}

/** Atomically return one retained ingress failure to its channel/account queue. */
export async function channelsDeadLettersResubmitCommand(
  eventId: string,
  options: ChannelsDeadLettersOptions,
): Promise<void> {
  const { channelId, accountId } = resolveScope(options);
  const queue = createChannelIngressQueue({ channelId, accountId });
  if (!queue.resubmit) {
    throw new Error("This runtime does not support channel ingress dead-letter resubmission.");
  }
  const result = await queue.resubmit(eventId);
  if (result.kind === "resubmitted") {
    if (options.json) {
      defaultRuntime.writeJson({ channelId, accountId, eventId, result });
    } else {
      defaultRuntime.log(
        `${theme.success("Resubmitted")} ${terminalText`channel ingress event ${eventId} (${channelId}/${accountId}). The running channel retries it within 5 minutes by default (longer if configured).`}`,
      );
    }
    return;
  }
  let message: string;
  switch (result.kind) {
    case "completed":
      message = `Ingress event ${eventId} is completed and cannot be resubmitted.`;
      break;
    case "active":
      message = `Ingress event ${eventId} is already ${result.status}.`;
      break;
    case "unrecoverable":
      message = `Ingress event ${eventId} has no retained payload and cannot be resubmitted.`;
      break;
    default:
      message = `Ingress event ${eventId} was not found for ${channelId}/${accountId}.`;
  }
  throw new Error(options.json ? message : terminalText`${message}`);
}
