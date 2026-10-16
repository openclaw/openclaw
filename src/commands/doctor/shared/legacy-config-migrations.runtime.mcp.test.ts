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
