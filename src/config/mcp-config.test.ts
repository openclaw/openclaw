import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { listConfiguredMcpServers, mcpConfigInternal } from "./mcp-config.js";
import { REDACTED_SENTINEL } from "./redact-snapshot.js";

const { set: setConfiguredMcpServer, unset: unsetConfiguredMcpServer } = mcpConfigInternal;

function stdio(command: string, arg: string) {
  return { command, args: [arg] };
}

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

const mockReplaceConfigFile = vi.hoisted(
  () =>
    async ({ sourceConfig }: { sourceConfig: unknown }) => {
      const fsLocal = await import("node:fs/promises");
      const pathLocal = await import("node:path");
      const configPath = pathLocal.join(process.env.OPENCLAW_STATE_DIR ?? "", "openclaw.json");
      await fsLocal.writeFile(configPath, JSON.stringify(sourceConfig, null, 2), "utf-8");
      return { nextConfig: sourceConfig };
    },
);

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

  it("does not overwrite an existing server in create-only mode", async () => {
    await withMcpServers({ docs: stdio("node", "existing.mjs") }, async () => {
      const result = await setConfiguredMcpServer({
        name: "docs",
        server: stdio("uvx", "docs-mcp"),
        createOnly: true,
      });

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
      expect((await readMcpServers()).docs).toEqual(stdio("node", "existing.mjs"));
    });
  });

  it("only replaces a server that still matches the expected config", async () => {
    await withMcpServers({ docs: stdio("node", "current.mjs") }, async () => {
      const stale = await setConfiguredMcpServer({
        name: "docs",
        server: stdio("uvx", "docs@2"),
        expectedServer: stdio("node", "stale.mjs"),
      });
      expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("changed") });

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

  it("restores redacted MCP secrets on set instead of writing the sentinel", async () => {
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
      const setResult = await setConfiguredMcpServer({
        name: "billing",
        server: {
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
        },
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
