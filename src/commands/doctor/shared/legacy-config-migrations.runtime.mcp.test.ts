import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { migrateLegacyConfigForTest } from "./legacy-config-migrate.apply.test-support.js";

describe("legacy MCP server config migrate", () => {
  it("moves disabled to enabled, preserves canonical values, and is idempotent", () => {
    const raw = {
      mcp: {
        servers: {
          disabled: { command: "example-mcp", disabled: true },
          enabled: { command: "example-mcp", disabled: false },
          canonical: { command: "example-mcp", disabled: true, enabled: true },
        },
      },
    };

    expect(findLegacyConfigIssues(raw)).toEqual([
      expect.objectContaining({
        path: "mcp.servers",
        message: expect.stringContaining('unsupported "disabled" key'),
      }),
    ]);
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.mcp?.servers).toEqual({
      disabled: { command: "example-mcp", enabled: false },
      enabled: { command: "example-mcp", enabled: true },
      canonical: { command: "example-mcp", enabled: true },
    });
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });

  it("moves MCP workingDirectory aliases to cwd with canonical values winning", () => {
    const raw = {
      mcp: {
        servers: {
          legacy: { command: "example-mcp", workingDirectory: "/legacy" },
          canonical: { command: "example-mcp", cwd: "/canonical", workingDirectory: "/legacy" },
        },
      },
      nodeHost: {
        mcp: {
          servers: {
            legacy: { command: "example-mcp", workingDirectory: "/node-legacy" },
          },
        },
      },
    };

    expect(findLegacyConfigIssues(raw)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "mcp.servers",
          message: expect.stringContaining("use camelCase spellings and cwd"),
        }),
        expect.objectContaining({
          path: "nodeHost.mcp.servers",
          message: expect.stringContaining("use camelCase spellings and cwd"),
        }),
      ]),
    );
    const res = migrateLegacyConfigForTest(raw);

    expect(res.config?.mcp?.servers).toEqual({
      legacy: { command: "example-mcp", cwd: "/legacy" },
      canonical: { command: "example-mcp", cwd: "/canonical" },
    });
    expect(res.config?.nodeHost?.mcp?.servers?.legacy).toEqual({
      command: "example-mcp",
      cwd: "/node-legacy",
    });
    expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
  });
});

describe("legacy migrate MCP server type aliases", () => {
  it.each(["mcp", "nodeHost"] as const)(
    "normalizes %s CLI transports with canonical precedence",
    (owner) => {
      const servers = {
        http: { type: "http", url: "https://example.com/mcp" },
        sse: { type: "sse", url: "https://example.com/sse" },
        canonical: { type: "http", transport: "sse", url: "https://example.com/canonical" },
        local: { type: "stdio", command: "node", args: ["server.js"] },
      };
      const raw = owner === "mcp" ? { mcp: { servers } } : { nodeHost: { mcp: { servers } } };
      expect(findLegacyConfigIssues(raw)).toContainEqual({
        path: owner === "mcp" ? "mcp.servers" : "nodeHost.mcp.servers",
        message: expect.stringContaining("CLI-native type aliases"),
      });
      const res = migrateLegacyConfigForTest(raw);
      expect(
        owner === "mcp" ? res.config?.mcp?.servers : res.config?.nodeHost?.mcp?.servers,
      ).toEqual({
        http: { transport: "streamable-http", url: "https://example.com/mcp" },
        sse: { transport: "sse", url: "https://example.com/sse" },
        canonical: { transport: "sse", url: "https://example.com/canonical" },
        local: { command: "node", args: ["server.js"] },
      });
      expect(migrateLegacyConfigForTest(res.config)).toEqual({ config: null, changes: [] });
    },
  );
});
