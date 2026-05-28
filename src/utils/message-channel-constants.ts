export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;

// Internal, non-delivery sources that may surface as a `channel` hint when an
// agent run is triggered by something other than a chat message — heartbeat
// ticks, cron jobs, or webhook receivers. They are not deliverable on their
// own, but they should still pass agent-param channel validation so internal
// callers (e.g. sessions_spawn from a heartbeat-driven parent run) are not
// rejected as "unknown channel".
export const INTERNAL_NON_DELIVERY_CHANNELS = ["heartbeat", "cron", "webhook", "voice"] as const;
export type InternalNonDeliveryChannel = (typeof INTERNAL_NON_DELIVERY_CHANNELS)[number];

export function isInternalNonDeliveryChannel(value: string): value is InternalNonDeliveryChannel {
  return (INTERNAL_NON_DELIVERY_CHANNELS as readonly string[]).includes(value);
}

/**
 * Typed error raised when an outbound delivery path is asked to route to
 * webchat. Webchat is the internal session-bound surface (see
 * {@link INTERNAL_MESSAGE_CHANNEL}); it has no outbound channel plugin and is
 * delivered via the live session reply stream, not via the queued outbound
 * pipeline.
 *
 * Callers that hit this error should not retry through the channel selector;
 * they should reshape their request:
 *   - cron: use `sessionTarget: "main"` + `payload.kind: "systemEvent"` for the
 *     default agent, or `sessionTarget: "session:agent:<id>:main"` +
 *     `payload.kind: "agentTurn"` + `delivery.mode: "none"` for non-default
 *     agents; in both cases the reply renders in the subscribed webchat tab
 *     via the session event broadcast without any channel-plugin involvement.
 *   - tool callers: pass `delivery.mode: "none"` and let the active session
 *     surface the reply through its normal render path.
 *
 * The CLI surfaces an equivalent rejection at `cron add` / `cron edit` time
 * when `--announce --channel webchat` is requested, so most users never reach
 * this runtime check. This typed error is the second line of defense for
 * RPC/API/raw-JSON callers that bypass the CLI.
 */
export class WebchatNotDeliverableError extends Error {
  readonly channel = INTERNAL_MESSAGE_CHANNEL;
  constructor(message?: string) {
    super(
      message ??
        `Webchat is not a deliverable channel (it is the internal session-bound surface, not a channel plugin). ` +
          `For a cron job, use sessionTarget="main" with payload.kind="systemEvent" (default agent only), or ` +
          `sessionTarget="session:agent:<id>:main" with payload.kind="agentTurn" and delivery.mode="none" for ` +
          `any non-default agent — the reply renders in the subscribed webchat tab via the session event ` +
          `broadcast. See docs/automation/cron-jobs.md “Webchat is not an announce target”.`,
    );
    this.name = "WebchatNotDeliverableError";
  }
}
