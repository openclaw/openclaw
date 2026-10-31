import { expect, it } from "vitest";
import { decodeResumeHandoff, encodeResumeHandoff } from "./resume-handoff.js";

const gatewayUrl = "wss://gateway.example/openclaw";
const handoff = { version: 1, sessionKey: "agent:main:alpha", gatewayUrl };
const error = "Invalid --handoff payload. Copy a fresh command from the Control UI.";

function encodeJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeText(encoded: string): string {
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

it("round-trips hostile cross-shell fields through only the inert base64url alphabet", () => {
  const sessionKey = "agent:runner:hostile-'\"$&;|<>^()%![]{}\\`-%PATH%-��";
  const hostileGatewayUrl = "wss://gateway.example/openclaw/$&;=()+,![]{}'`/%25PATH%25/%E2%98%83";
  const expected = { version: 1, sessionKey, gatewayUrl: hostileGatewayUrl };
  const encoded = encodeResumeHandoff({ sessionKey, gatewayUrl: hostileGatewayUrl });

  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
  expect(encoded).not.toContain("=");
  expect(decodeText(encoded)).toBe(JSON.stringify(expected));
  expect(decodeResumeHandoff(encoded)).toEqual(expected);
});

it.each<[string, string]>([
  ["padding", "Zg=="],
  ["noncanonical encoding", "Zh"],
  ["null", encodeJson(null)],
  ["extra field", encodeJson({ ...handoff, token: "nope" })],
  ["wrong URL type", encodeJson({ ...handoff, gatewayUrl: 42 })],
  ["key C0 control", encodeJson({ ...handoff, sessionKey: "agent:main:bad\nkey" })],
  ["URL C0 control", encodeJson({ ...handoff, gatewayUrl: `${gatewayUrl}\u0000` })],
  ["non-WebSocket URL", encodeJson({ ...handoff, gatewayUrl: "https://gateway.example" })],
  ["URL userinfo", encodeJson({ ...handoff, gatewayUrl: "wss://user@gateway.example/ws" })],
  ["URL query", encodeJson({ ...handoff, gatewayUrl: "wss://gateway.example/ws?x=1" })],
  ["URL fragment", encodeJson({ ...handoff, gatewayUrl: "wss://gateway.example/ws#x" })],
  ["invalid qualified key", encodeJson({ ...handoff, sessionKey: "main" })],
])("rejects %s", (_name, encoded) => {
  expect(() => decodeResumeHandoff(encoded)).toThrow(error);
});

it("refuses to encode an empty Gateway URL", () => {
  expect(() => encodeResumeHandoff({ ...handoff, gatewayUrl: "" })).toThrow(error);
});
