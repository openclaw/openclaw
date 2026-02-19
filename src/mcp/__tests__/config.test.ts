/**
 * MCP Config Schema & Validation Tests
 *
 * Phase 1: TDD — these tests are written FIRST, then implementation follows.
 */
import { describe, it, expect } from "vitest";
import { McpConfigSchema, validateMcpConfig, type McpConfig } from "../config.js";

describe("McpConfigSchema", () => {
  // --- Valid configs ---

  it("accepts valid stdio server config", () => {
    const config: McpConfig = {
      servers: {
        filesystem: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts valid SSE server config", () => {
    const config: McpConfig = {
      servers: {
        remote: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts valid HTTP (streamable) server config", () => {
    const config: McpConfig = {
      servers: {
        remote: {
          transport: "http",
          url: "https://mcp.example.com/mcp",
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts disabled server", () => {
    const config: McpConfig = {
      servers: {
        disabled: {
          enabled: false,
          transport: "stdio",
          command: "echo",
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("defaults transport to stdio (command present, no transport)", () => {
    const config: McpConfig = {
      servers: {
        myserver: {
          command: "my-mcp-server",
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts secret:// URIs in env", () => {
    const config: McpConfig = {
      servers: {
        linkedin: {
          command: "mcp-linkedin",
          env: {
            API_KEY: "secret://gcp/linkedin-api-key",
            OTHER: "plaintext-value",
          },
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts secret:// URIs in headers", () => {
    const config: McpConfig = {
      servers: {
        remote: {
          transport: "sse",
          url: "https://mcp.example.com/sse",
          headers: {
            Authorization: "secret://env/MCP_TOKEN",
          },
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts custom toolPrefix", () => {
    const config: McpConfig = {
      servers: {
        myserver: {
          command: "my-mcp-server",
          toolPrefix: "custom",
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts resource config options", () => {
    const config: McpConfig = {
      servers: {
        myserver: {
          command: "my-mcp-server",
          resources: true,
          resourceFilter: ["file:///data/*"],
          resourceRefreshMs: 60000,
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts empty servers object (no-op)", () => {
    const config: McpConfig = {
      servers: {},
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it("accepts lazy startup config", () => {
    const config: McpConfig = {
      servers: {
        myserver: {
          command: "my-mcp-server",
          lazy: true,
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  // --- Invalid configs ---

  it("rejects stdio without command", () => {
    const config = {
      servers: {
        bad: {
          transport: "stdio",
          // no command
        },
      },
    };
    const result = validateMcpConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects SSE without url", () => {
    const config = {
      servers: {
        bad: {
          transport: "sse",
          // no url
        },
      },
    };
    const result = validateMcpConfig(config);
    expect(result.success).toBe(false);
  });

  it("rejects HTTP without url", () => {
    const config = {
      servers: {
        bad: {
          transport: "http",
          // no url
        },
      },
    };
    const result = validateMcpConfig(config);
    expect(result.success).toBe(false);
  });

  it("validates timeout is positive", () => {
    const config = {
      servers: {
        bad: {
          command: "echo",
          timeout: -1,
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("validates toolTimeout is positive", () => {
    const config = {
      servers: {
        bad: {
          command: "echo",
          toolTimeout: 0,
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("validates maxRestarts is non-negative", () => {
    const config = {
      servers: {
        bad: {
          command: "echo",
          maxRestarts: -1,
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects unknown transport type", () => {
    const config = {
      servers: {
        bad: {
          transport: "websocket",
          command: "echo",
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it("rejects unknown properties (strict mode)", () => {
    const config = {
      servers: {
        bad: {
          command: "echo",
          unknownProp: true,
        },
      },
    };
    const result = McpConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("validateMcpConfig", () => {
  it("returns success with valid config", () => {
    const result = validateMcpConfig({
      servers: {
        test: { command: "echo" },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.servers?.test?.command).toBe("echo");
    }
  });

  it("returns actionable error messages", () => {
    const result = validateMcpConfig({
      servers: {
        bad: { transport: "sse" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // Error message should mention url or sse
      const msg = result.error;
      expect(msg).toBeTruthy();
    }
  });

  it("validates disabled server skips transport checks", () => {
    const result = validateMcpConfig({
      servers: {
        off: { enabled: false },
      },
    });
    expect(result.success).toBe(true);
  });
});
