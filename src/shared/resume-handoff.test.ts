// Shared contract tests run in Node using only the browser-compatible globals used in production.
import { describe, expect, it } from "vitest";
import { decodeResumeHandoff, encodeResumeHandoff } from "./resume-handoff.js";

const gatewayUrl = "wss://gateway.example/openclaw";

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeText(encoded: string): string {
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

describe("resume handoff contract", () => {
  it("round-trips hostile cross-shell fields through only the inert base64url alphabet", () => {
    const sessionKey = "agent:runner:hostile-'\"$&;|<>^()%![]{}\\`-%PATH%-��";
    const hostileGatewayUrl = "wss://gateway.example/openclaw/$&;=()+,![]{}'`/%25PATH%25/%E2%98%83";

    const encoded = encodeResumeHandoff({ sessionKey, gatewayUrl: hostileGatewayUrl });

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(encoded).not.toContain("=");
    expect(decodeText(encoded)).toBe(
      JSON.stringify({ version: 1, sessionKey, gatewayUrl: hostileGatewayUrl }),
    );
    expect(decodeResumeHandoff(encoded)).toEqual({
      version: 1,
      sessionKey,
      gatewayUrl: hostileGatewayUrl,
    });
  });

  it.each<[string, string]>([
    ["padding", "Zg=="],
    ["noncanonical encoding", "Zh"],
    ["null", encodeJson(null)],
    [
      "extra field",
      encodeJson({ version: 1, sessionKey: "agent:main:alpha", gatewayUrl, token: "nope" }),
    ],
    ["wrong URL type", encodeJson({ version: 1, sessionKey: "agent:main:alpha", gatewayUrl: 42 })],
    ["key C0 control", encodeJson({ version: 1, sessionKey: "agent:main:bad\nkey", gatewayUrl })],
    [
      "URL C0 control",
      encodeJson({ version: 1, sessionKey: "agent:main:alpha", gatewayUrl: `${gatewayUrl}\u0000` }),
    ],
    [
      "non-WebSocket URL",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "https://gateway.example",
      }),
    ],
    [
      "URL userinfo",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://user@gateway.example/ws",
      }),
    ],
    [
      "URL query",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://gateway.example/ws?x=1",
      }),
    ],
    [
      "URL fragment",
      encodeJson({
        version: 1,
        sessionKey: "agent:main:alpha",
        gatewayUrl: "wss://gateway.example/ws#x",
      }),
    ],
    ["invalid qualified key", encodeJson({ version: 1, sessionKey: "main", gatewayUrl })],
  ])("rejects %s", (_name, encoded) => {
    expect(() => decodeResumeHandoff(encoded)).toThrow(
      "Invalid --handoff payload. Copy a fresh command from the Control UI.",
    );
  });

  it("refuses to encode an empty Gateway URL", () => {
    expect(() => encodeResumeHandoff({ sessionKey: "agent:main:alpha", gatewayUrl: "" })).toThrow(
      "Invalid --handoff payload. Copy a fresh command from the Control UI.",
    );
  });
});
