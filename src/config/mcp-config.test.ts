// Covers MCP config normalization, validation, and serialization.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
  updateConfiguredMcpServer,
  updateConfiguredMcpServerTools,
} from "./mcp-config.js";

function validationOk(raw: unknown) {
  return { ok: true as const, config: raw, warnings: [] };
}

const mockReadSourceConfigSnapshot = vi.hoisted(() => async () => {
  const fsValue = await import("node:fs/promises");
  const pathValue = await import("node:path");
  const configPath = pathValue.join(process.env.OPENCLAW_STATE_DIR ?? "", "openclaw.json");
  try {
    const raw = await fsValue.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      valid: true,
      path: configPath,
      sourceConfig: parsed,
      resolved: parsed,
      hash: "test-hash",
    };
  } catch {
    return {
      valid: false,
      path: configPath,
    };
  }
});

const mockReplaceConfigFile = vi.hoisted(() => async ({ nextConfig }: { nextConfig: unknown }) => {
  const fsLocal = await import("node:fs/promises");
  const pathLocal = await import("node:path");
  const configPath = pathLocal.join(process.env.OPENCLAW_STATE_DIR ?? "", "openclaw.json");
  await fsLocal.writeFile(configPath, JSON.stringify(nextConfig, null, 2), "utf-8");
});

vi.mock("./io.js", () => ({
  readSourceConfigSnapshot: mockReadSourceConfigSnapshot,
}));

vi.mock("./mutate.js", () => ({
  replaceConfigFile: mockReplaceConfigFile,
}));

vi.mock("./validation.js", () => ({
  validateConfigObjectWithPlugins: validationOk,
  validateConfigObjectRawWithPlugins: validationOk,
}));

async function withMcpConfigHome<T>(
  config: unknown,
  fn: (params: { configPath: string }) => Promise<T>,
) {
  return await withTempHome(
    async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
      return await fn({ configPath });
    },
    {
      prefix: "openclaw-mcp-config-",
      skipSessionCleanup: true,
      env: {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      },
    },
  );
}

describe("config mcp config", () => {
  it("writes and removes top-level mcp servers", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "context7",
        server: {
          command: "uvx",
          args: ["context7-mcp"],
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.context7).toEqual({
        command: "uvx",
        args: ["context7-mcp"],
      });

      const unsetResult = await unsetConfiguredMcpServer({ name: "context7" });
      expect(unsetResult.ok).toBe(true);

      const reloaded = await listConfiguredMcpServers();
      expect(reloaded.ok).toBe(true);
      if (!reloaded.ok) {
        throw new Error("expected MCP config to reload");
      }
      expect(reloaded.mcpServers).toStrictEqual({});
    });
  });

  it("fails closed when the config file is invalid", async () => {
    await withMcpConfigHome({}, async ({ configPath }) => {
      await fs.writeFile(configPath, "{", "utf-8");

      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        throw new Error("expected invalid config to fail");
      }
      expect(loaded.path).toBe(configPath);
    });
  });

  it("rejects blocked stdio env keys before saving MCP config", async () => {
    await withMcpConfigHome({}, async () => {
      const blockedResult = await setConfiguredMcpServer({
        name: "docs",
        server: {
          command: "node",
          env: {
            PYTHONPATH: "/tmp/mcp-shadow",
            PYTHONUNBUFFERED: "1",
          },
        },
      });

      expect(blockedResult.ok).toBe(false);
      if (blockedResult.ok) {
        throw new Error("expected blocked stdio env config to fail");
      }
      expect(blockedResult.error).toBe(
        'MCP stdio env key "PYTHONPATH" is blocked by startup safety policy and cannot be saved. Remove it from the server env config.',
      );

      const loadedAfterFailure = await listConfiguredMcpServers();
      expect(loadedAfterFailure.ok).toBe(true);
      if (!loadedAfterFailure.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loadedAfterFailure.mcpServers).not.toHaveProperty("docs");

      const safeResult = await setConfiguredMcpServer({
        name: "docs",
        server: {
          command: "node",
          env: {
            PYTHONUNBUFFERED: "1",
          },
        },
      });

      expect(safeResult.ok).toBe(true);
      const loadedAfterSafeWrite = await listConfiguredMcpServers();
      expect(loadedAfterSafeWrite.ok).toBe(true);
      if (!loadedAfterSafeWrite.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loadedAfterSafeWrite.mcpServers.docs).toEqual({
        command: "node",
        env: {
          PYTHONUNBUFFERED: "1",
        },
      });
    });
  });

  it("sanitizes blocked stdio env key names in config errors", async () => {
    await withMcpConfigHome({}, async () => {
      const unsafeKey = `LD_PRELOAD\nWARN forged${String.fromCharCode(0x1b)}[31m`;
      const result = await setConfiguredMcpServer({
        name: "docs",
        server: {
          command: "node",
          env: {
            [unsafeKey]: "/tmp/pwn.so",
          },
        },
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected blocked stdio env config to fail");
      }
      expect(result.error).toBe(
        'MCP stdio env key "LD_PRELOADWARN forged" is blocked by startup safety policy and cannot be saved. Remove it from the server env config.',
      );
    });
  });

  it("allows unrelated updates when blocked stdio env keys are legacy", async () => {
    await withMcpConfigHome(
      {
        mcp: {
          servers: {
            docs: {
              command: "node",
              env: {
                PYTHONPATH: "/tmp/mcp-shadow",
              },
            },
          },
        },
      },
      async () => {
        const configureResult = await updateConfiguredMcpServer({
          name: "docs",
          update: (server) => ({ ...server, timeout: 5 }),
        });

        expect(configureResult.ok).toBe(true);
        if (!configureResult.ok) {
          throw new Error("expected unrelated MCP config update to succeed");
        }
        expect(configureResult.mcpServers.docs).toEqual({
          command: "node",
          env: {
            PYTHONPATH: "/tmp/mcp-shadow",
          },
          timeout: 5,
        });

        const toolsResult = await updateConfiguredMcpServerTools({
          name: "docs",
          tools: { include: ["search"] },
        });

        expect(toolsResult.ok).toBe(true);
        if (!toolsResult.ok) {
          throw new Error("expected unrelated MCP tool update to succeed");
        }
        expect(toolsResult.mcpServers.docs).toEqual({
          command: "node",
          env: {
            PYTHONPATH: "/tmp/mcp-shadow",
          },
          timeout: 5,
          toolFilter: { include: ["search"] },
        });
      },
    );
  });

  it("rejects updates that introduce blocked stdio env keys", async () => {
    await withMcpConfigHome(
      {
        mcp: {
          servers: {
            docs: {
              command: "node",
              env: {
                PYTHONUNBUFFERED: "1",
              },
            },
          },
        },
      },
      async () => {
        const configureResult = await updateConfiguredMcpServer({
          name: "docs",
          update: (server) => ({
            ...server,
            env: {
              ...(server.env as Record<string, unknown>),
              PYTHONPATH: "/tmp/mcp-shadow",
            },
          }),
        });

        expect(configureResult.ok).toBe(false);
        if (configureResult.ok) {
          throw new Error("expected introduced blocked stdio env update to fail");
        }
        expect(configureResult.error).toBe(
          'MCP stdio env key "PYTHONPATH" is blocked by startup safety policy and cannot be saved. Remove it from the server env config.',
        );
      },
    );
  });

  it("accepts SSE MCP configs with headers at the config layer", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "remote",
        server: {
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer token123",
            "X-Retry": 1,
            "X-Debug": true,
          },
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.remote).toEqual({
        url: "https://example.com/mcp",
        headers: {
          Authorization: "Bearer token123",
          "X-Retry": 1,
          "X-Debug": true,
        },
      });
    });
  });

  it("canonicalizes CLI-native HTTP type aliases when saving MCP config", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "remote",
        server: {
          type: "http",
          url: "https://example.com/mcp",
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.remote).toEqual({
        url: "https://example.com/mcp",
        transport: "streamable-http",
      });
    });
  });

  it("canonicalizes common MCP operator aliases when saving config", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "remote",
        server: {
          url: "https://example.com/mcp",
          connect_timeout: 5,
          supports_parallel_tool_calls: true,
          ssl_verify: false,
          client_cert: "/tmp/client.crt",
          client_key: "/tmp/client.key",
        },
      });

      expect(setResult.ok).toBe(true);
      const loaded = await listConfiguredMcpServers();
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw new Error("expected MCP config to load");
      }
      expect(loaded.mcpServers.remote).toEqual({
        url: "https://example.com/mcp",
        connectTimeout: 5,
        supportsParallelToolCalls: true,
        sslVerify: false,
        clientCert: "/tmp/client.crt",
        clientKey: "/tmp/client.key",
      });
    });
  });
});
