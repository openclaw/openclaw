/**
 * Canonical bundled chat-channel id list.
 *
 * Re-exports the same constant the inbound-envelope formatter
 * (src/auto-reply/envelope.ts -> formatInboundEnvelope -> formatAgentEnvelope)
 * uses for its leading `[<channel> ...]` header, so any plugin that needs to
 * recognize an envelope-prefixed message (for example a memory plugin filtering
 * envelope sludge out of long-term capture) does not have to hardcode its own
 * channel-id table that can drift from the formatter contract.
 *
 * The list is derived from the bundled channel config metadata
 * (`src/config/bundled-channel-config-metadata.generated.ts`) and stays in
 * lockstep with channel registration; new bundled channels appear here
 * automatically.
 */
export { CHAT_CHANNEL_ORDER as BUNDLED_CHAT_CHANNEL_IDS } from "../channels/ids.js";
export type { ChatChannelId } from "../channels/ids.js";
