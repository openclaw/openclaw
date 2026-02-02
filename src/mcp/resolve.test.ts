import { describe, expect, it } from "vitest";
import { resolveEffectiveMcpServers, isMcpServerEnabled } from "./resolve.js";

describe("resolveEffectiveMcpServers", () => {
  it("merges root mcpServers with per-agent overrides and normalizes keys", () => {
    const cfg: any = {
      mcpServers: {
        Filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "./"],
        },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect(Object.keys(merged).toSorted()).toEqual(["filesystem", "github"]);
    expect((merged.filesystem as any).command).toBe("npx");
    expect((merged.github as any).command).toBe("npx");
  });

  it("allows per-agent overrides to disable globally defined servers", () => {
    const cfg: any = {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "./"],
        },
      },
      agents: {
        list: [
          {
            id: "main",
            mcpServers: {
              filesystem: { enabled: false, command: "npx", args: [] },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "main" });
    expect((merged.filesystem as any).enabled).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Empty/missing config handling
  // ---------------------------------------------------------------------------

  it("returns empty object when config is undefined", () => {
    const merged = resolveEffectiveMcpServers({ config: undefined, agentId: "main" });
    expect(merged).toEqual({});
  });

  it("returns empty object when config is empty", () => {
    const merged = resolveEffectiveMcpServers({ config: {}, agentId: "main" });
    expect(merged).toEqual({});
  });

  it("returns empty object when mcpServers is null", () => {
    const merged = resolveEffectiveMcpServers({
      config: { mcpServers: null } as any,
      agentId: "main",
    });
    expect(merged).toEqual({});
  });

  it("returns empty object when mcpServers is undefined", () => {
    const merged = resolveEffectiveMcpServers({
      config: { mcpServers: undefined } as any,
      agentId: "main",
    });
    expect(merged).toEqual({});
  });

  it("returns empty object when mcpServers is not an object", () => {
    const merged = resolveEffectiveMcpServers({
      config: { mcpServers: "invalid" } as any,
      agentId: "main",
    });
    expect(merged).toEqual({});
  });

  it("returns empty object when mcpServers is an array", () => {
    const merged = resolveEffectiveMcpServers({
      config: { mcpServers: ["not", "valid"] } as any,
      agentId: "main",
    });
    expect(merged).toEqual({});
  });

  // ---------------------------------------------------------------------------
  // Key normalization
  // ---------------------------------------------------------------------------

  it("normalizes server keys to lowercase", () => {
    const merged = resolveEffectiveMcpServers({
      config: {
        mcpServers: {
          GitHub: { command: "gh-mcp" },
          FILESYSTEM: { command: "fs-mcp" },
          MixedCase: { command: "mixed-mcp" },
        },
      } as any,
      agentId: "main",
    });

    expect(Object.keys(merged).toSorted()).toEqual(["filesystem", "github", "mixedcase"]);
  });

  it("trims whitespace from server keys", () => {
    const merged = resolveEffectiveMcpServers({
      config: {
        mcpServers: {
          "  spaced  ": { command: "spaced-mcp" },
          "\tTabs\t": { command: "tabs-mcp" },
        },
      } as any,
      agentId: "main",
    });

    expect(Object.keys(merged).toSorted()).toEqual(["spaced", "tabs"]);
  });

  it("skips servers with empty keys after normalization", () => {
    const merged = resolveEffectiveMcpServers({
      config: {
        mcpServers: {
          valid: { command: "valid-mcp" },
          "   ": { command: "empty-mcp" },
          "": { command: "also-empty-mcp" },
        },
      } as any,
      agentId: "main",
    });

    expect(Object.keys(merged)).toEqual(["valid"]);
  });

  // ---------------------------------------------------------------------------
  // Agent-specific configurations
  // ---------------------------------------------------------------------------

  it("returns only global servers when agentId is undefined", () => {
    const cfg: any = {
      mcpServers: {
        global: { command: "global-mcp" },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              agentOnly: { command: "agent-mcp" },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: undefined });
    expect(Object.keys(merged)).toEqual(["global"]);
  });

  it("returns only global servers when agentId is empty string", () => {
    const cfg: any = {
      mcpServers: {
        global: { command: "global-mcp" },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              agentOnly: { command: "agent-mcp" },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "" });
    expect(Object.keys(merged)).toEqual(["global"]);
  });

  it("returns only global servers when agent is not found", () => {
    const cfg: any = {
      mcpServers: {
        global: { command: "global-mcp" },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              agentOnly: { command: "agent-mcp" },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "nonexistent" });
    expect(Object.keys(merged)).toEqual(["global"]);
  });

  it("returns only global servers when agent has no mcpServers", () => {
    const cfg: any = {
      mcpServers: {
        global: { command: "global-mcp" },
      },
      agents: {
        list: [
          {
            id: "work",
            // No mcpServers defined
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect(Object.keys(merged)).toEqual(["global"]);
  });

  it("handles agents.list being undefined", () => {
    const cfg: any = {
      mcpServers: {
        global: { command: "global-mcp" },
      },
      agents: {},
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect(Object.keys(merged)).toEqual(["global"]);
  });

  it("handles agents being undefined", () => {
    const cfg: any = {
      mcpServers: {
        global: { command: "global-mcp" },
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect(Object.keys(merged)).toEqual(["global"]);
  });

  // ---------------------------------------------------------------------------
  // Per-agent override behavior
  // ---------------------------------------------------------------------------

  it("per-agent config overrides global config for same server ID", () => {
    const cfg: any = {
      mcpServers: {
        github: { command: "global-gh", args: ["--global"] },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              github: { command: "agent-gh", args: ["--agent"] },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect((merged.github as any).command).toBe("agent-gh");
    expect((merged.github as any).args).toEqual(["--agent"]);
  });

  it("per-agent can add new servers not in global", () => {
    const cfg: any = {
      mcpServers: {
        global: { command: "global-mcp" },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              agentOnly: { command: "agent-mcp" },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect(Object.keys(merged).toSorted()).toEqual(["agentonly", "global"]);
  });

  it("handles multiple agents with different overrides", () => {
    const cfg: any = {
      mcpServers: {
        shared: { command: "shared-mcp" },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              work_only: { command: "work-mcp" },
            },
          },
          {
            id: "personal",
            mcpServers: {
              personal_only: { command: "personal-mcp" },
            },
          },
        ],
      },
    };

    const workMerged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect(Object.keys(workMerged).toSorted()).toEqual(["shared", "work_only"]);

    const personalMerged = resolveEffectiveMcpServers({ config: cfg, agentId: "personal" });
    expect(Object.keys(personalMerged).toSorted()).toEqual(["personal_only", "shared"]);
  });

  // ---------------------------------------------------------------------------
  // Enabled/disabled handling
  // ---------------------------------------------------------------------------

  it("preserves enabled: true in merged config", () => {
    const cfg: any = {
      mcpServers: {
        server: { command: "mcp", enabled: true },
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "main" });
    expect((merged.server as any).enabled).toBe(true);
  });

  it("preserves enabled: false in global config", () => {
    const cfg: any = {
      mcpServers: {
        server: { command: "mcp", enabled: false },
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "main" });
    expect((merged.server as any).enabled).toBe(false);
  });

  it("per-agent can re-enable a globally disabled server", () => {
    const cfg: any = {
      mcpServers: {
        server: { command: "mcp", enabled: false },
      },
      agents: {
        list: [
          {
            id: "work",
            mcpServers: {
              server: { command: "mcp", enabled: true },
            },
          },
        ],
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "work" });
    expect((merged.server as any).enabled).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Transport types in merged config
  // ---------------------------------------------------------------------------

  it("preserves SSE transport config in merged result", () => {
    const cfg: any = {
      mcpServers: {
        remote: {
          transport: "sse",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "main" });
    expect((merged.remote as any).transport).toBe("sse");
    expect((merged.remote as any).url).toBe("https://example.com/mcp");
    expect((merged.remote as any).headers).toEqual({ Authorization: "Bearer token" });
  });

  it("preserves HTTP transport config in merged result", () => {
    const cfg: any = {
      mcpServers: {
        http_server: {
          transport: "http",
          url: "https://api.example.com/mcp",
          headers: { "X-API-Key": "secret" },
        },
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "main" });
    expect((merged.http_server as any).transport).toBe("http");
    expect((merged.http_server as any).url).toBe("https://api.example.com/mcp");
  });

  it("preserves stdio transport config with all options", () => {
    const cfg: any = {
      mcpServers: {
        local: {
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          cwd: "/app",
          env: { DEBUG: "true" },
          stderr: "inherit",
          label: "Local MCP",
        },
      },
    };

    const merged = resolveEffectiveMcpServers({ config: cfg, agentId: "main" });
    expect((merged.local as any).transport).toBe("stdio");
    expect((merged.local as any).command).toBe("node");
    expect((merged.local as any).args).toEqual(["server.js"]);
    expect((merged.local as any).cwd).toBe("/app");
    expect((merged.local as any).env).toEqual({ DEBUG: "true" });
    expect((merged.local as any).stderr).toBe("inherit");
    expect((merged.local as any).label).toBe("Local MCP");
  });
});

// ---------------------------------------------------------------------------
// isMcpServerEnabled
// ---------------------------------------------------------------------------

describe("isMcpServerEnabled", () => {
  it("returns true when enabled is not set", () => {
    expect(isMcpServerEnabled({ command: "mcp" })).toBe(true);
  });

  it("returns true when enabled is true", () => {
    expect(isMcpServerEnabled({ command: "mcp", enabled: true })).toBe(true);
  });

  it("returns false when enabled is false", () => {
    expect(isMcpServerEnabled({ command: "mcp", enabled: false })).toBe(false);
  });

  it("returns false when server is undefined", () => {
    expect(isMcpServerEnabled(undefined)).toBe(false);
  });

  it("returns true for SSE server without enabled field", () => {
    expect(
      isMcpServerEnabled({
        transport: "sse",
        url: "https://example.com",
      }),
    ).toBe(true);
  });

  it("returns true for HTTP server without enabled field", () => {
    expect(
      isMcpServerEnabled({
        transport: "http",
        url: "https://example.com",
      }),
    ).toBe(true);
  });

  it("returns false for SSE server with enabled: false", () => {
    expect(
      isMcpServerEnabled({
        transport: "sse",
        url: "https://example.com",
        enabled: false,
      }),
    ).toBe(false);
  });
});
