import fs from "node:fs";
import nodePath from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { registerConfigCli } from "../cli/config-cli.js";
import { persistRequestedUpdateChannel } from "../cli/update-cli/update-command-config.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { defaultRuntime } from "../runtime.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createConfigIO } from "./io.js";
import * as metadata from "./io.plugin-metadata.js";
import { REDACTED_SENTINEL } from "./redact-sentinel.js";
import type { OpenClawConfig } from "./types.js";

afterEach(() => vi.restoreAllMocks());

async function runCli(
  config: OpenClawConfig,
  args?: string[],
  before?: (env: NodeJS.ProcessEnv) => Promise<void>,
) {
  let output: unknown;
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    output = value;
  });
  if (!args) {
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  }
  await withOpenClawTestState({ prefix: "config-cli-validation-" }, async (state) => {
    await state.writeConfig(config);
    const raw = fs.readFileSync(state.configPath, "utf8");
    await before?.(state.env);
    const program = new Command();
    program.exitOverride();
    registerConfigCli(program);
    try {
      await program.parseAsync(["config", ...(args ?? ["validate", "--json"])], { from: "user" });
    } catch (error) {
      if (args) {
        throw error;
      }
      expect(error).toMatchObject({ name: "ExitError", code: 1 });
    }
    expect(fs.readFileSync(state.configPath, "utf8")).toBe(raw);
  });
  return output;
}

it.each(["get", "validate"] as const)("core %s redacts without metadata", async (command) => {
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync").mockRejectedValue(
    new Error("Plugin metadata is unavailable"),
  );
  const output = await runCli(
    { gateway: { mode: "local", auth: { mode: "token", token: "synthetic-core-token" } } },
    command === "get" ? ["get", "gateway.auth.token", "--json"] : ["validate", "--json"],
  );
  expect(output).toEqual(
    command === "get" ? REDACTED_SENTINEL : expect.objectContaining({ valid: true, warnings: [] }),
  );
});

async function validateThroughCli(
  config: OpenClawConfig,
  schema: Record<string, unknown>,
  channelSchema?: Record<string, unknown>,
) {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "plugin",
        configSchema: schema,
        ...(channelSchema && {
          channels: ["channel"],
          channelConfigs: { channel: { schema: channelSchema } },
        }),
        configContracts: { secretInputs: { paths: [{ path: "credential", expected: "string" }] } },
      },
    ],
  });
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshot").mockReturnValue(snapshot);
  vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync").mockResolvedValue(snapshot);
  return runCli(config);
}

it("validates existing state through a private read-only snapshot", async () => {
  const output = await runCli(
    { gateway: { mode: "local" }, plugins: { enabled: false } },
    undefined,
    async (env) => {
      stateDb.openOpenClawStateDatabase({ env });
      await stateDb.closeOpenClawStateDatabaseAsync();
    },
  );
  expect(output).toMatchObject({ valid: true });
});

const objectSchema = (properties = {}) => ({ type: "object", properties });
const pluginConfig = (enabled: boolean, config?: Record<string, unknown>) => ({
  plugins: { entries: { plugin: { enabled, ...(config ? { config } : {}) } } },
});
const issue = (path: string, details = {}) => ({
  valid: false,
  issues: [expect.objectContaining({ path, ...details })],
});

it.each(["mcp", "nodeHost"] as const)(
  "rejects mixed %s MCP transports through the CLI",
  async (owner) => {
    const mcp = { servers: { docs: { command: "node", url: "https://example.com/mcp" } } };
    const output = await runCli(owner === "mcp" ? { mcp } : { nodeHost: { mcp } });
    expect(output).toMatchObject(
      issue(`${owner === "mcp" ? "mcp" : "nodeHost.mcp"}.servers.docs`, {
        message: expect.stringMatching(/command.*url/),
      }),
    );
  },
);

it("warns for saved mixed config, rejects edits, and lets updates persist their channel", async () => {
  await withOpenClawTestState({ prefix: "mixed-mcp-upgrade-" }, async (state) => {
    await state.writeConfig({
      mcp: {
        servers: {
          docs: { command: "node", url: "https://example.com/mcp", env: { DATA_DIR: "~/data" } },
        },
      },
    });
    const raw = fs.readFileSync(state.configPath, "utf8");
    const logger = { warn: vi.fn(), error: vi.fn() };
    const io = createConfigIO({
      env: state.env,
      configPath: state.configPath,
      observe: false,
      pluginValidation: "core-only",
      logger,
    });
    expect(io.loadConfig().mcp?.servers?.docs).toEqual({
      command: "node",
      url: "https://example.com/mcp",
      env: { DATA_DIR: nodePath.join(state.home, "data") },
    });
    expect(logger.warn.mock.calls.flat().join("\n")).toMatch(/mcp.servers.docs.*command.*url/s);
    const explicit = await io.readConfigFileSnapshotWithPluginMetadata({
      prepareValidation: "strict",
      completePluginMetadata: false,
    });
    expect(explicit.strictIssues).toEqual([
      expect.objectContaining({
        path: "mcp.servers.docs",
        message: expect.stringMatching(/command.*url/),
      }),
    ]);
    await expect(
      io.writeConfigFile({
        mcp: {
          servers: {
            docs: { command: "node", args: ["changed.js"], url: "https://example.com/mcp" },
          },
        },
      }),
    ).rejects.toThrow(/docs.*command.*url/s);
    expect(fs.readFileSync(state.configPath, "utf8")).toBe(raw);
    await persistRequestedUpdateChannel({
      configSnapshot: await io.readConfigFileSnapshot(),
      requestedChannel: "beta",
    });
    expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toMatchObject({
      update: { channel: "beta" },
      mcp: {
        servers: {
          docs: { command: "node", url: "https://example.com/mcp", env: { DATA_DIR: "~/data" } },
        },
      },
    });
  });
});

it("repairs one mixed server without blocking on another and rejects new or edited ambiguity", async () => {
  await withOpenClawTestState({ prefix: "mixed-mcp-mutation-" }, async (state) => {
    const mixed = {
      command: "old-server",
      url: "https://example.com/mcp",
      env: { DATA_DIR: "~/data" },
    };
    await state.writeConfig({ mcp: { servers: { first: mixed, second: mixed } } });
    expect(
      await setConfiguredMcpServer({ name: "first", server: { command: "first-server" } }),
    ).toMatchObject({ ok: true });
    expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toMatchObject({
      mcp: { servers: { first: { command: "first-server" }, second: mixed } },
    });
    for (const name of ["second", "new"]) {
      expect(
        await setConfiguredMcpServer({ name, server: { ...mixed, command: "changed-server" } }),
      ).toMatchObject({ ok: false, error: expect.stringMatching(/command.*url/) });
    }
  });
});

it.each([
  { channel: true, rootPath: "/synthetic", valid: true },
  { channel: true, rootPath: "~/synthetic", valid: false },
  { channel: false, rootPath: "~/synthetic", valid: false },
])(
  "validates raw paths (channel=$channel, path=$rootPath)",
  async ({ channel, rootPath, valid }) => {
    const schema = objectSchema({ rootPath: { type: "string", pattern: "^/" } });
    const output = await validateThroughCli(
      channel ? { channels: { channel: { rootPath } } } : pluginConfig(true, { rootPath }),
      channel ? objectSchema() : schema,
      channel
        ? objectSchema({ ...schema.properties, label: { type: "string", default: "synthetic" } })
        : undefined,
    );
    const path = channel ? "channels.channel.rootPath" : "plugins.entries.plugin.config.rootPath";
    expect(output).toMatchObject(valid ? { valid } : issue(path));
  },
);

it.each([true, false])("preserves strict default ownership (enabled=%s)", async (enabled) => {
  const output = await validateThroughCli(
    {
      ...pluginConfig(enabled, enabled ? undefined : {}),
      secrets: {
        providers: { shared: { source: "file", path: "/synthetic/secrets.json", mode: "json" } },
      },
    },
    objectSchema({
      credential: {
        type: "object",
        default: { source: "exec", provider: "shared", id: "synthetic" },
      },
    }),
  );
  expect(output).toMatchObject(
    enabled
      ? { valid: true }
      : issue("plugins.entries.plugin.config.credential", {
          message: expect.stringContaining('has source "file" but ref requests "exec"'),
        }),
  );
});
