import { describe, expect, it } from "vitest";
import { mcpServerHints, mcpServerSchema, mcpSettingsSchema } from "./mcp-schema.ts";

const serverProperties = Object.fromEntries(
  [
    "enabled",
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "transport",
    "headers",
    "auth",
    "oauth",
    "sslVerify",
    "requestTimeoutMs",
  ].map((key) => [key, { type: "string" }]),
);
const schema = {
  type: "object",
  properties: {
    mcp: {
      type: "object",
      properties: {
        sessionIdleTtlMs: { type: "number" },
        apps: {
          type: "object",
          properties: { enabled: { type: "boolean" }, sandboxPort: { type: "integer" } },
        },
        servers: {
          type: "object",
          additionalProperties: { type: "object", properties: serverProperties },
        },
      },
    },
  },
};
const keysOf = (node: unknown) =>
  Object.keys((node as { properties: Record<string, unknown> }).properties);

describe("mcpSettingsSchema", () => {
  it("leaves servers and the Apps switch to the page and keeps a stable identity", () => {
    const narrowed = mcpSettingsSchema(schema) as typeof schema;
    expect(keysOf(narrowed.properties.mcp)).toEqual(["sessionIdleTtlMs", "apps"]);
    expect(keysOf(narrowed.properties.mcp.properties.apps)).toEqual(["sandboxPort"]);
    expect(mcpSettingsSchema(schema)).toBe(narrowed);
  });

  it("passes through a schema without an mcp section", () => {
    const other = { type: "object", properties: {} };
    expect(mcpSettingsSchema(other)).toBe(other);
    expect(mcpSettingsSchema(null)).toBeNull();
  });
});

describe("mcpServerSchema", () => {
  it("shows a stdio server its own fields", () => {
    expect(keysOf(mcpServerSchema(schema, { command: "node" }, true))).toEqual([
      "cwd",
      "env",
      "requestTimeoutMs",
    ]);
  });

  it("shows a URL server its own fields, with OAuth as a switch", () => {
    const server = mcpServerSchema(schema, { url: "https://mcp.test" }, false);
    expect(keysOf(server)).toEqual([
      "url",
      "auth",
      "headers",
      "oauth",
      "sslVerify",
      "requestTimeoutMs",
    ]);
    expect((server as { properties: { auth: unknown } }).properties.auth).toEqual({
      type: "boolean",
    });
  });

  it("keeps a saved field of the other connection kind reachable", () => {
    expect(keysOf(mcpServerSchema(schema, { command: "node", sslVerify: false }, true))).toContain(
      "sslVerify",
    );
  });

  it("returns null when the Gateway schema has no server shape", () => {
    expect(mcpServerSchema({ properties: {} }, null, false)).toBeNull();
  });
});

describe("mcpServerHints", () => {
  it("drops the repeated MCP prefix and keeps connection secrets in the common tier", () => {
    const hints = mcpServerHints({
      "mcp.servers.*.requestTimeoutMs": { label: "MCP Request Timeout (ms)", advanced: true },
      "mcp.servers.*.auth": { label: "MCP Server Auth", advanced: false },
      "mcp.servers.*.env.*": { sensitive: true, advanced: true },
    });
    expect(hints["mcp.servers.*.requestTimeoutMs"]?.label).toBe("Request Timeout (ms)");
    expect(hints["mcp.servers.*.env.*"]).toMatchObject({ sensitive: true, advanced: false });
    expect(hints["mcp.servers.*.auth"]?.advanced).toBe(false);
  });
});
