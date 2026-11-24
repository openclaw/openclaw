import type { RealtimeTalkJsonPcmWebSocketSessionResult } from "./shared.ts";

const GOOGLE_LIVE_WEBSOCKET_HOST = "generativelanguage.googleapis.com";
const GOOGLE_LIVE_WEBSOCKET_PATH =
  /^\/ws\/google\.ai\.generativelanguage\.v[0-9a-z]+\.GenerativeService\.BidiGenerateContent(?:Constrained)?$/;
export const GOOGLE_LIVE_SETUP_TIMEOUT_MS = 30_000;

export function buildGoogleLiveUrl(session: RealtimeTalkJsonPcmWebSocketSessionResult): string {
  let url: URL;
  try {
    url = new URL(session.websocketUrl);
  } catch {
    throw new Error("Invalid Google Live WebSocket URL");
  }
  if (url.protocol !== "wss:") {
    throw new Error("Google Live WebSocket URL must use wss://");
  }
  if (url.hostname.toLowerCase() !== GOOGLE_LIVE_WEBSOCKET_HOST) {
    throw new Error("Untrusted Google Live WebSocket host");
  }
  if (url.username || url.password) {
    throw new Error("Google Live WebSocket URL must not include credentials");
  }
  if (!GOOGLE_LIVE_WEBSOCKET_PATH.test(url.pathname)) {
    throw new Error("Untrusted Google Live WebSocket path");
  }
  url.search = "";
  url.searchParams.set("access_token", session.clientSecret);
  return url.toString();
}
