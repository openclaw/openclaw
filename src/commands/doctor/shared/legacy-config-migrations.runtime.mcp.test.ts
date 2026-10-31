import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfigForTest } from "./legacy-config-migrate.apply.test-support.js";

const command = (settings: Record<string, unknown>) => ({ command: "example-mcp", ...settings });
const transports = {
  http: { type: "http", url: "https://example.com/mcp" },
  sse: { type: "sse", url: "https://example.com/sse" },
  canonical: { type: "http", transport: "sse", url: "https://example.com/canonical" },
  local: { type: "stdio", command: "node", args: ["server.js"] },
};
const canonicalTransports = {
  http: { transport: "streamable-http", url: "https://example.com/mcp" },
  sse: { transport: "sse", url: "https://example.com/sse" },
  canonical: { transport: "sse", url: "https://example.com/canonical" },
  local: { command: "node", args: ["server.js"] },
};

describe("legacy MCP server config migrate", () => {
  it("repairs shared mixed transports in both scopes without removing requester identity", () => {
    const shared = command({
      args: ["server.js"],
      env: { MODE: "test" },
      cwd: "/example",
      url: "https://example.com/mcp",
      type: "http",
      headers: { "X-Test": "test" },
      auth: "oauth",
      oauth: { identity: "shared" },
      sslVerify: false,
      clientCert: "/cert",
      clientKey: "/key",
      requestTimeoutMs: 1000,
      toolFilter: { include: ["read_*"] },
    });
    const requester = { ...shared, oauth: { identity: "per-requester" } };
    const servers = { shared, requester, missingAuth: { ...requester, auth: undefined } };
    const raw = { mcp: { servers }, nodeHost: { mcp: { servers } } };
    expect(findLegacyConfigIssues(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "mcp.servers",
          message: expect.stringContaining('"command" and "url"'),
        }),
        expect.objectContaining({
          path: "nodeHost.mcp.servers",
          message: expect.stringContaining('"command" and "url"'),
        }),
      ]),
    );
    const result = migrateLegacyConfigForTest(raw);
    const expected = {
      shared: command({
        args: ["server.js"],
        env: { MODE: "test" },
        cwd: "/example",
        requestTimeoutMs: 1000,
        toolFilter: { include: ["read_*"] },
      }),
      requester: { ...requester, type: undefined, transport: "streamable-http" },
      missingAuth: { ...requester, auth: undefined, type: undefined, transport: "streamable-http" },
    };
    expect(result.config).toEqual({
      mcp: { servers: expected },
      nodeHost: { mcp: { servers: expected } },
    });
    expect(result.changes.join("\n")).toContain("stdio");
    expect(migrateLegacyConfigForTest(result.config)).toEqual({ config: null, changes: [] });
  });

  it.each([
    {
      name: "disabled flags",
      raw: {
        mcp: {
          servers: {
            disabled: command({ disabled: true }),
            enabled: command({ disabled: false }),
            canonical: command({ disabled: true, enabled: true }),
          },
        },
      },
      expected: {
        mcp: {
          servers: {
            disabled: command({ enabled: false }),
            enabled: command({ enabled: true }),
            canonical: command({ enabled: true }),
          },
        },
      },
      paths: ["mcp.servers"],
      message: 'unsupported "disabled" key',
    },
    {
      name: "working directories",
      raw: {
        mcp: {
          servers: {
            legacy: command({ workingDirectory: "/legacy" }),
            canonical: command({ cwd: "/canonical", workingDirectory: "/legacy" }),
          },
        },
        nodeHost: { mcp: { servers: { legacy: command({ workingDirectory: "/node-legacy" }) } } },
      },
      expected: {
        mcp: {
          servers: {
            legacy: command({ cwd: "/legacy" }),
            canonical: command({ cwd: "/canonical" }),
          },
        },
        nodeHost: { mcp: { servers: { legacy: command({ cwd: "/node-legacy" }) } } },
      },
      paths: ["mcp.servers", "nodeHost.mcp.servers"],
      message: "use camelCase spellings and cwd",
    },
    ...(["mcp", "nodeHost"] as const).map((owner) => ({
      name: `${owner} transports`,
      raw:
        owner === "mcp"
          ? { mcp: { servers: transports } }
          : { nodeHost: { mcp: { servers: transports } } },
      expected:
        owner === "mcp"
          ? { mcp: { servers: canonicalTransports } }
          : { nodeHost: { mcp: { servers: canonicalTransports } } },
      paths: [owner === "mcp" ? "mcp.servers" : "nodeHost.mcp.servers"],
      message: "CLI-native type aliases",
    })),
  ])("canonicalizes $name with explicit values winning", ({ raw, expected, paths, message }) => {
    expect(findLegacyConfigIssues(raw)).toEqual(
      paths.map((path) => ({ path, message: expect.stringContaining(message) })),
    );
    const res = migrateLegacyConfigForTest(raw);
    expect(res.config).toEqual(expected);
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });
});
