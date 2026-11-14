import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  listConfiguredMcpServers,
  mcpConfigInternal,
  redactMcpServersForDisplay,
} from "./mcp-config.js";
import { REDACTED_SENTINEL } from "./redact-snapshot.js";

const { set: setConfiguredMcpServer, unset: unsetConfiguredMcpServer } = mcpConfigInternal;

function stdio(command: string, arg: string) {
  return { command, args: [arg] };
}

function validationOk(raw: unknown) {
  return { ok: true as const, config: raw, warnings: [] };
}

const { mockReadSourceConfigSnapshot, mockReplaceConfigFile } = vi.hoisted(() => {
  async function file() {
    const fileSystem = await import("node:fs/promises");
    const paths = await import("node:path");
    return {
      fileSystem,
      configPath: paths.join(process.env.OPENCLAW_STATE_DIR ?? "", "openclaw.json"),
    };
  }
  return {
    mockReadSourceConfigSnapshot: async () => {
      const { fileSystem, configPath } = await file();
      try {
        const parsed = JSON.parse(await fileSystem.readFile(configPath, "utf-8"));
        return {
          valid: true,
          path: configPath,
          sourceConfig: parsed,
          resolved: parsed,
          hash: "test-hash",
        };
      } catch {
        return { valid: false, path: configPath };
      }
    },
    mockReplaceConfigFile: async ({ sourceConfig }: { sourceConfig: unknown }) => {
      const { fileSystem, configPath } = await file();
      await fileSystem.writeFile(configPath, JSON.stringify(sourceConfig, null, 2), "utf-8");
      return { nextConfig: sourceConfig };
    },
  };
});

vi.mock("./io.js", () => ({
  readSourceConfigSnapshot: mockReadSourceConfigSnapshot,
  readSourceConfigSnapshotForWrite: async () => ({
    snapshot: await mockReadSourceConfigSnapshot(),
    writeOptions: {},
  }),
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

async function readMcpServers() {
  const loaded = await listConfiguredMcpServers();
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) {
    throw new Error("expected MCP config to load");
  }
  return loaded.mcpServers;
}

async function withMcpServers(servers: Record<string, unknown>, fn: () => Promise<void>) {
  return withMcpConfigHome({ mcp: { servers } }, fn);
}

describe("config mcp config", () => {
  it("mutates one detached config while preserving the source and commit-hook history", async () => {
    const config = {
      mcp: { servers: { docs: { command: "node", env: { MODE: "original" } } } },
      agents: { entries: { main: { name: "Original" } } },
    };
    await withMcpConfigHome(config, async () => {
      const clone = vi.spyOn(globalThis, "structuredClone");
      const committed = vi.fn();
      try {
        const result = await mcpConfigInternal.update(
          {
            name: "docs",
            update: (server) => {
              (server.env as Record<string, string>).MODE = "updated";
              return server;
            },
          },
          committed,
        );
        expect(result.ok).toBe(true);
        expect(clone).toHaveBeenCalledOnce();
        expect(clone.mock.calls[0]?.[0]).toEqual(config);
        expect(committed).toHaveBeenCalledWith({
          name: "docs",
          previous: { command: "node", env: { MODE: "original" } },
          next: { command: "node", env: { MODE: "updated" } },
        });
        if (result.ok) {
          result.config.agents!.entries!.main!.name = "Changed after commit";
          expect(clone.mock.calls[0]?.[0]).toEqual(config);
        }
      } finally {
        clone.mockRestore();
      }
    });
  });

  it("writes and removes top-level mcp servers", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "context7",
        server: stdio("uvx", "context7-mcp"),
      });

      expect(setResult.ok).toBe(true);
      expect((await readMcpServers()).context7).toEqual(stdio("uvx", "context7-mcp"));

      const unsetResult = await unsetConfiguredMcpServer({ name: "context7" });
      expect(unsetResult.ok).toBe(true);

      expect(await readMcpServers()).toStrictEqual({});
    });
  });

  it.each([
    ["create-only", { createOnly: true }, "already exists"],
    ["stale owner", { expectedServer: stdio("node", "stale.mjs") }, "changed"],
  ] as const)("does not overwrite a server for %s", async (_name, options, error) => {
    const current = stdio("node", "current.mjs");
    await withMcpServers({ docs: current }, async () => {
      const result = await setConfiguredMcpServer({
        name: "docs",
        server: stdio("uvx", "docs@2"),
        ...options,
      });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(error) });
      expect((await readMcpServers()).docs).toEqual(current);
    });
  });

  it("only replaces a server that still matches the expected config", async () => {
    await withMcpServers({ docs: stdio("node", "current.mjs") }, async () => {
      const replaced = await setConfiguredMcpServer({
        name: "docs",
        server: stdio("uvx", "docs@2"),
        expectedServer: stdio("node", "current.mjs"),
      });
      expect(replaced.ok).toBe(true);

      expect((await readMcpServers()).docs).toEqual(stdio("uvx", "docs@2"));
    });
  });

  it("does not remove a server that changed after ownership inspection", async () => {
    await withMcpServers({ docs: stdio("node", "changed.mjs") }, async () => {
      const result = await unsetConfiguredMcpServer({
        name: "docs",
        expectedServer: stdio("uvx", "docs-mcp"),
      });

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
      expect((await readMcpServers()).docs).toEqual(stdio("node", "changed.mjs"));
    });
  });

  it("fails closed when the config file is invalid", async () => {
    await withMcpConfigHome({}, async ({ configPath }) => {
      await fs.writeFile(configPath, "{", "utf-8");

      const loaded = await listConfiguredMcpServers();
      expect(loaded).toMatchObject({ ok: false, path: configPath });
    });
  });

  it("redacts MCP secrets for display and restores them on set", async () => {
    const billing = {
      command: "uvx",
      args: [
        "billing-mcp",
        "--api-key",
        "real-argv-key",
        "--token=real-inline-token",
        "ghp_realgithubtoken1234567890ABCD",
        "--region",
        "us-east-1",
      ],
      headers: { Authorization: "Bearer real-token" },
      env: { BILLING_TOKEN: "real-env-secret" },
    };
    await withMcpServers({ billing }, async () => {
      const redacted = redactMcpServersForDisplay({ billing }).billing;
      expect(redacted).toEqual({
        command: "uvx",
        args: [
          "billing-mcp",
          "--api-key",
          REDACTED_SENTINEL,
          `--token=${REDACTED_SENTINEL}`,
          REDACTED_SENTINEL,
          "--region",
          "us-east-1",
        ],
        headers: { Authorization: REDACTED_SENTINEL },
        env: { BILLING_TOKEN: REDACTED_SENTINEL },
      });
      expect(billing.headers.Authorization).toBe("Bearer real-token");
      const setResult = await setConfiguredMcpServer({
        name: "billing",
        server: redacted,
      });

      expect(setResult.ok).toBe(true);
      expect((await readMcpServers()).billing).toEqual(billing);
    });
  });

  it("rejects redacted MCP argv when its flag binding or shape changed", async () => {
    await withMcpServers(
      { billing: { command: "uvx", args: ["billing-mcp", "--api-key", "real-argv-key"] } },
      async () => {
        async function expectRejectedArgs(args: string[], error: string) {
          const result = await setConfiguredMcpServer({
            name: "billing",
            server: { command: "uvx", args },
          });
          expect(result).toMatchObject({ ok: false, error: expect.stringContaining(error) });
        }
        await expectRejectedArgs(["billing-mcp", "--output", REDACTED_SENTINEL], REDACTED_SENTINEL);
        await expectRejectedArgs(
          ["other-mcp", "--api-key", REDACTED_SENTINEL],
          "Replace every redacted value explicitly",
        );
        await expectRejectedArgs(["--api-key", REDACTED_SENTINEL], REDACTED_SENTINEL);
      },
    );
  });

  it("canonicalizes CLI-native HTTP type aliases when saving MCP config", async () => {
    await withMcpConfigHome({}, async () => {
      const setResult = await setConfiguredMcpServer({
        name: "remote",
        server: { type: "http", url: "https://example.com/mcp" },
      });

      expect(setResult.ok).toBe(true);
      expect((await readMcpServers()).remote).toEqual({
        url: "https://example.com/mcp",
        transport: "streamable-http",
      });
    });
  });
});
