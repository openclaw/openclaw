import { GatewayRelayRealtimeTalkTransport } from "./gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";
import type {
  RealtimeTalkSessionResult,
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
} from "./shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./webrtc.ts";

export function createRealtimeTalkTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  if (session.transport === "webrtc") {
    return new WebRtcSdpRealtimeTalkTransport(session, ctx);
  }
  if (session.transport === "provider-websocket") {
    return new GoogleLiveRealtimeTalkTransport(session, ctx);
  }
  if (session.transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(session, ctx);
  }
  const unknownTransport = session.transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}
