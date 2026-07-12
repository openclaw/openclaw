// MCP runtime migration tests cover doctor legacy config migrations for MCP server config shape.
import { describe, it, expect } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";

describe("mcp.servers.disabled->enabled migration", () => {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP.find(
    (m) => m.id === "mcp.servers.disabled->enabled",
  );

  it("migrates disabled: true to enabled: false", () => {
    const changes: string[] = [];
    const raw: {
      mcp: {
        servers: Record<string, { disabled?: boolean; enabled?: boolean; command?: string }>;
      };
    } = {
      mcp: {
        servers: {
          myServer: {
            disabled: true,
            command: "npx",
          },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(true);

    migration!.apply(raw, changes);

    expect(raw.mcp.servers.myServer.enabled).toBe(false);
    expect(raw.mcp.servers.myServer.disabled).toBeUndefined();
    expect(raw.mcp.servers.myServer.command).toBe("npx");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("disabled → enabled: false");
    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(false);
  });

  it("removes disabled: false as a no-op (server enabled by default)", () => {
    const changes: string[] = [];
    const raw: {
      mcp: {
        servers: Record<string, { disabled?: boolean; enabled?: boolean; command?: string }>;
      };
    } = {
      mcp: {
        servers: {
          myServer: {
            disabled: false,
            command: "npx",
          },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(true);

    migration!.apply(raw, changes);

    expect(raw.mcp.servers.myServer.enabled).toBeUndefined();
    expect(raw.mcp.servers.myServer.disabled).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("no-op, server enabled by default");
    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(false);
  });

  it("preserves explicit enabled: true when disabled is also present", () => {
    const changes: string[] = [];
    const raw: {
      mcp: {
        servers: Record<string, { disabled?: boolean; enabled?: boolean; command?: string }>;
      };
    } = {
      mcp: {
        servers: {
          myServer: {
            disabled: true,
            enabled: true,
            command: "npx",
          },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(true);

    migration!.apply(raw, changes);

    expect(raw.mcp.servers.myServer.enabled).toBe(true);
    expect(raw.mcp.servers.myServer.disabled).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("canonical enabled: true preserved");
    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(false);
  });

  it("preserves explicit enabled: false when disabled is also present", () => {
    const changes: string[] = [];
    const raw: {
      mcp: {
        servers: Record<string, { disabled?: boolean; enabled?: boolean; command?: string }>;
      };
    } = {
      mcp: {
        servers: {
          myServer: {
            disabled: false,
            enabled: false,
            command: "npx",
          },
        },
      },
    };

    migration!.apply(raw, changes);

    expect(raw.mcp.servers.myServer.enabled).toBe(false);
    expect(raw.mcp.servers.myServer.disabled).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("canonical enabled: false preserved");
    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(false);
  });

  it("handles multiple servers with mixed states", () => {
    const changes: string[] = [];
    const raw: {
      mcp: {
        servers: Record<string, { disabled?: boolean; enabled?: boolean; command?: string }>;
      };
    } = {
      mcp: {
        servers: {
          serverA: { disabled: true, command: "a" },
          serverB: { disabled: false, command: "b" },
          serverC: { disabled: true, enabled: false, command: "c" },
          serverD: { command: "d" },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(true);

    migration!.apply(raw, changes);

    expect(raw.mcp.servers.serverA.enabled).toBe(false);
    expect(raw.mcp.servers.serverA.disabled).toBeUndefined();
    expect(raw.mcp.servers.serverB.enabled).toBeUndefined();
    expect(raw.mcp.servers.serverB.disabled).toBeUndefined();
    expect(raw.mcp.servers.serverC.enabled).toBe(false);
    expect(raw.mcp.servers.serverC.disabled).toBeUndefined();
    expect(raw.mcp.servers.serverD.disabled).toBeUndefined();
    expect(raw.mcp.servers.serverD.enabled).toBeUndefined();
    expect(changes).toHaveLength(3);
    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(false);
  });

  it("handles missing mcp section gracefully", () => {
    const changes: string[] = [];
    const raw = {};

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles missing mcp.servers section gracefully", () => {
    const changes: string[] = [];
    const raw = { mcp: {} };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("handles non-record server entries gracefully", () => {
    const changes: string[] = [];
    const raw = {
      mcp: {
        servers: {
          myServer: "string-value",
        },
      },
    };

    migration!.apply(raw, changes);

    expect(changes).toHaveLength(0);
  });

  it("does not match when no server has disabled key", () => {
    const raw = {
      mcp: {
        servers: {
          serverA: { command: "a" },
          serverB: { command: "b" },
        },
      },
    };

    expect(migration!.legacyRules?.[0]?.match?.(raw.mcp.servers, raw)).toBe(false);
  });
});
