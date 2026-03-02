import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackMonitorContext } from "./context.js";
import { registerSlackChannelEvents } from "./events/channels.js";
import { registerSlackInteractionEvents } from "./events/interactions.js";
import { registerSlackMemberEvents } from "./events/members.js";
import { registerSlackMessageEvents } from "./events/messages.js";
import { registerSlackPinEvents } from "./events/pins.js";
import { registerSlackReactionEvents } from "./events/reactions.js";
import type { SlackMessageHandler } from "./message-handler.js";

export function registerSlackMonitorEvents(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handleSlackMessage: SlackMessageHandler;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
  /** Called on each inbound channel event (not DM) to track channel event liveness. */
  trackChannelEvent?: (isChannel: boolean) => void;
}) {
  registerSlackMessageEvents({
    ctx: params.ctx,
    handleSlackMessage: params.handleSlackMessage,
  });
  registerSlackReactionEvents({
    ctx: params.ctx,
    trackEvent: params.trackEvent,
    trackChannelEvent: params.trackChannelEvent,
  });
  registerSlackMemberEvents({
    ctx: params.ctx,
    trackEvent: params.trackEvent,
    trackChannelEvent: params.trackChannelEvent,
  });
  registerSlackChannelEvents({
    ctx: params.ctx,
    trackEvent: params.trackEvent,
    trackChannelEvent: params.trackChannelEvent,
  });
  registerSlackPinEvents({
    ctx: params.ctx,
    trackEvent: params.trackEvent,
    trackChannelEvent: params.trackChannelEvent,
  });
  registerSlackInteractionEvents({ ctx: params.ctx });
}
