/**
 * Plugin SDK types for native streaming channel echo (B-full).
 *
 * Registration is owner-scoped through the plugin activation API; the public
 * subpath intentionally exports only the renderer contracts so third-party
 * plugins cannot claim another channel's echo renderer registry entry.
 */
export type {
  ChannelEchoRenderer,
  EchoRendererFactory,
  EchoRendererFactoryParams,
} from "../infra/outbound/echo-streaming.js";
