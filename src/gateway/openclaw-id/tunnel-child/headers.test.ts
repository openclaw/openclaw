import { describe, expect, it } from "vitest";
import { upstreamHeaders } from "./headers.js";

const facts = {
  peerKey: `iroh:${"ab".repeat(32)}`,
  proxyToken: "boot-token",
  peerAddress: "fd69:726f:6800:1:2:3:4:5",
  forwardedProto: "https" as const,
};

describe("tunnel ingress headers", () => {
  it("replaces client-supplied ingress and identity headers with authenticated facts", () => {
    const headers = upstreamHeaders(
      [
        ["Host", "claw.example.test"],
        ["X-OpenClaw-Id-Peer-Key", `iroh:${"00".repeat(32)}`],
        ["X-OpenClaw-Id-Proxy-Token", "forged"],
        ["X-Forwarded-For", "127.0.0.1"],
        ["X-Forwarded-User", "mallory"],
        ["X-OpenClaw-Scopes", "operator.admin"],
        ["Remote-User", "mallory"],
        ["CF-Access-Authenticated-User-Email", "mallory@example.test"],
        ["CF-Access-JWT-Assertion", "untrusted-assertion"],
        ["Tailscale-User-Login", "mallory@example.test"],
        ["Tailscale-User-Name", "Mallory"],
        ["X-Real-IP", "127.0.0.1"],
        ["X-Tcid-Device", "x"],
        ["Forwarded", "for=127.0.0.1"],
        ["Connection", "x-custom"],
        ["X-Custom", "dropped because Connection lists it"],
        ["Accept-Encoding", "gzip"],
        ["Cookie", "a=1"],
        ["Cookie", "b=2"],
      ],
      facts,
      "http",
    );
    expect(headers).toEqual({
      host: "claw.example.test",
      "accept-encoding": "gzip",
      cookie: ["a=1", "b=2"],
      "x-openclaw-id-peer-key": facts.peerKey,
      "x-openclaw-id-proxy-token": "boot-token",
      "x-forwarded-for": facts.peerAddress,
      "x-forwarded-proto": "https",
      "x-forwarded-host": "claw.example.test",
    });
  });

  it("drops WebSocket handshake headers but keeps Origin", () => {
    const headers = upstreamHeaders(
      [
        ["Origin", "https://claw.example.test"],
        ["Sec-WebSocket-Key", "abc"],
        ["Sec-WebSocket-Protocol", "x"],
      ],
      facts,
      "ws",
    );
    expect(headers.origin).toBe("https://claw.example.test");
    expect(headers["sec-websocket-key"]).toBeUndefined();
    expect(headers["sec-websocket-protocol"]).toBeUndefined();
  });
});
