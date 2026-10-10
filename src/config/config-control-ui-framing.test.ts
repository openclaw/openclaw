import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

describe("gateway.controlUi.frameAncestors", () => {
  it.each([
    undefined,
    [],
    ["'self'"],
    ["codex-sandbox:", "https://*.web-sandbox.oaiusercontent.com"],
    ["my-app+embed:", "https://chat.example.test:8443"],
    ["https://EXAMPLE.test", "https://localhost", "https://127.0.0.1:443"],
  ])("accepts explicit frame sources without rewriting them: %j", (frameAncestors) => {
    const config = { controlUi: { frameAncestors } };
    expect(GatewayConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    "*",
    "'none'",
    "self",
    '"self"',
    "'https://example.test'",
    "http:",
    "https:",
    "ws:",
    "wss:",
    "ftp:",
    "ftps:",
    "sftp:",
    "ssh:",
    "gopher:",
    "data:",
    "blob:",
    "javascript:",
    "file:",
    "filesystem:",
    "about:",
    "hTtPs:",
    "http://example.test",
    "http://127.0.0.1:18789",
    "https://*",
    "https://*example.test",
    "https://a.*.example.test",
    "https://*.*.example.test",
    "https://example.test/",
    "https://example.test/path",
    "https://example.test?query",
    "https://example.test#fragment",
    "https://user@example.test",
    "https://example.test:*",
    "https://example.test:abc",
    "https://example..test",
    "https://-example.test",
    "https://example.test\\path",
    "codex-sandbox://host",
    "https://example.test;script-src *",
    "https://example.test 'self'",
    " https://example.test",
    "https://example.test\n",
    "codex-sandbox:\t",
    "",
    42,
    null,
  ])("rejects unsafe or malformed frame sources: %j", (source) => {
    const result = GatewayConfigSchema.safeParse({ controlUi: { frameAncestors: [source] } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["controlUi", "frameAncestors", 0]);
  });
});
