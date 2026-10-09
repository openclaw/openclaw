import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadFreshAgentsBindCommandModuleForTest,
  readConfigFileSnapshotMock,
  resetAgentsBindTestHarness,
  runtime,
  writeConfigFileMock,
} from "./agents.bind.test-support.js";
import { baseConfigSnapshot } from "./test-runtime-config-helpers.js";

const pluginRegistryMocks = vi.hoisted(() => ({
  listPluginContributionIds: vi.fn(() => ["external-chat"]),
}));
vi.mock("../config/bindings.js", () => ({
  isRouteBinding: (binding: { match?: unknown }) => Boolean(binding.match),
  listRouteBindings: (cfg: OpenClawConfig) =>
    (cfg.bindings ?? []).filter((binding) => Boolean(binding.match)),
}));
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  listPluginContributionIds: pluginRegistryMocks.listPluginContributionIds,
}));
vi.mock("../channels/plugins/index.js", () => ({ getLoadedChannelPlugin: () => undefined }));
type BindingPlugin = Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> & {
  setupContract?: Pick<NonNullable<ChannelPlugin["setupContract"]>, "resolveBindingAccountId">;
};
vi.mock("../channels/plugins/bundled.js", () => ({
  getBundledChannelSetupPlugin: (channel: string): BindingPlugin | undefined => {
    const id = channel.trim().toLowerCase();
    if (!["telegram", "signal", "whatsapp"].includes(id)) {
      return undefined;
    }
    return {
      id,
      meta: { id, label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: "Fixture" },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => (id === "whatsapp" ? ["default", "biz"] : []),
        resolveAccount: () => ({}),
      },
      ...(id === "signal"
        ? { setupContract: { resolveBindingAccountId: ({ agentId }) => agentId.toLowerCase() } }
        : {}),
    };
  },
}));

let commands: Awaited<ReturnType<typeof loadFreshAgentsBindCommandModuleForTest>>;
const setConfig = (config: OpenClawConfig) =>
  readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot, config });
const route = (channel: string, accountId?: string, agentId = "main") => ({
  type: "route" as const,
  agentId,
  match: { channel, ...(accountId ? { accountId } : {}) },
});
const conflictConfig: OpenClawConfig = {
  agents: { entries: { ops: { workspace: "/tmp/ops" } } },
  bindings: [route("telegram", "ops")],
};
const jsonRuntime = () => ({ ...runtime, writeStdout: vi.fn(), writeJson: vi.fn() });

describe("agents bind/unbind commands", () => {
  beforeAll(async () => {
    commands = await loadFreshAgentsBindCommandModuleForTest();
  });
  beforeEach(() => {
    resetAgentsBindTestHarness();
    pluginRegistryMocks.listPluginContributionIds.mockReset().mockReturnValue(["external-chat"]);
    setConfig({});
  });

  it("lists routing bindings without plugin validation", async () => {
    setConfig({ bindings: [route("matrix"), route("telegram", "work", "ops")] });
    await commands.agentsBindingsCommand({}, runtime);
    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({ skipPluginValidation: true });
    expect(runtime.log).toHaveBeenCalledWith(
      "Routing bindings:\n- main <- matrix\n- ops <- telegram accountId=work",
    );
  });

  it.each(["ops", "main"])("uses the persisted default %s for bind and unbind", async (agentId) => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId } },
        entries: { main: {}, ops: {} },
      },
    };
    setConfig(config);
    await commands.agentsUpdateBindingsCommand("bind", { bind: ["telegram:work"] }, runtime);
    const bound = { ...config, bindings: [route("telegram", "work", agentId)] };
    expect(writeConfigFileMock).toHaveBeenLastCalledWith(bound);

    setConfig(bound);
    await commands.agentsUpdateBindingsCommand("unbind", { bind: ["telegram:work"] }, runtime);
    expect(writeConfigFileMock).toHaveBeenLastCalledWith({ ...config, bindings: undefined });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("requires an explicit agent when a fleet has no default", async () => {
    setConfig({ agents: { ownership: "explicit", entries: { main: {}, ops: {} } } });
    await expect(
      commands.agentsUpdateBindingsCommand("bind", { bind: ["telegram"] }, runtime),
    ).rejects.toThrow("Multiple agents are configured");
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("matches normalized account identities for conflicts, repeats, and removal", async () => {
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      bindings: [route("telegram", "Work", "ops")],
    };
    setConfig(config);
    const output = jsonRuntime();
    await commands.agentsUpdateBindingsCommand(
      "bind",
      { agent: "main", bind: ["telegram:work"], json: true },
      output,
    );
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(output.exit).toHaveBeenCalledWith(1);
    expect(output.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ conflicts: ["telegram accountId=work (agent=ops)"] }),
      2,
    );

    await commands.agentsUpdateBindingsCommand(
      "bind",
      { agent: "ops", bind: ["telegram:WORK"] },
      runtime,
    );
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    await commands.agentsUpdateBindingsCommand(
      "unbind",
      { agent: "ops", bind: ["telegram:work"] },
      runtime,
    );
    expect(writeConfigFileMock).toHaveBeenLastCalledWith({ ...config, bindings: undefined });
  });

  it("binds a mixed batch using one manifest inventory per invocation", async () => {
    await commands.agentsUpdateBindingsCommand(
      "bind",
      { bind: ["telegram", "whatsapp", "signal", "external-chat:work", "external-chat:home"] },
      runtime,
    );
    expect(writeConfigFileMock).toHaveBeenCalledExactlyOnceWith({
      bindings: [
        route("telegram"),
        route("whatsapp", "*"),
        route("signal", "main"),
        route("external-chat", "work"),
        route("external-chat", "home"),
      ],
    });
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledExactlyOnceWith({
      contribution: "channels",
      includeDisabled: true,
      config: {},
      env: process.env,
    });
    expect(runtime.exit).not.toHaveBeenCalled();
    pluginRegistryMocks.listPluginContributionIds.mockReturnValueOnce([]);
    await expect(
      commands.agentsUpdateBindingsCommand("bind", { bind: ["external-chat:next"] }, runtime),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Unknown channel "external-chat"'),
    });
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "strict-invalid agent",
      command: "bind",
      options: { agent: "агент✨", bind: ["telegram"], json: true },
      message: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "unknown list agent",
      command: "list",
      options: { agent: "ghost", json: true },
      message: 'Agent "ghost" not found. Run openclaw agents list to see configured agents.',
    },
    {
      name: "empty bindings",
      command: "bind",
      options: { json: true },
      message: "Provide at least one --bind <channel[:accountId]>.",
    },
    {
      name: "malformed binding batch",
      command: "bind",
      options: {
        bind: ["telegram:", "telegram:work:extra", "definitely-not-a-channel"],
        json: true,
      },
      message: [
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
      ].join("\n"),
    },
    {
      name: "incompatible unbind options",
      command: "unbind",
      options: { all: true, bind: ["telegram"], json: true },
      message: "Use either --all or --bind, not both.",
    },
  ] satisfies Array<{
    name: string;
    command: "bind" | "list" | "unbind";
    options: { agent?: string; bind?: string[]; json?: boolean; all?: boolean };
    message: string;
  }>)("rejects $name before mutation", async ({ command, options, message }) => {
    const execution =
      command === "list"
        ? commands.agentsBindingsCommand(options, runtime)
        : commands.agentsUpdateBindingsCommand(command, options, runtime);
    await expect(execution).rejects.toMatchObject({
      name: "ExpectedCliError",
      message,
      humanOutput: message,
      machineOutput: message,
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("unbinds all routes for one agent while preserving the others", async () => {
    setConfig({ ...conflictConfig, bindings: [route("matrix"), route("telegram", "work", "ops")] });
    await commands.agentsUpdateBindingsCommand("unbind", { agent: "ops", all: true }, runtime);
    expect(writeConfigFileMock).toHaveBeenCalledExactlyOnceWith({
      ...conflictConfig,
      bindings: [route("matrix")],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports empty unbind-all as JSON without writes or text logs", async () => {
    const output = jsonRuntime();
    await commands.agentsUpdateBindingsCommand(
      "unbind",
      { agent: "main", all: true, json: true },
      output,
    );
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(output.log).not.toHaveBeenCalled();
    expect(output.writeJson).toHaveBeenCalledExactlyOnceWith(
      {
        agentId: "main",
        removed: [],
        missing: [],
        conflicts: [],
      },
      2,
    );
    expect(output.exit).not.toHaveBeenCalled();
  });

  it("reports human unbind ownership conflicts without writing", async () => {
    setConfig(conflictConfig);
    await commands.agentsUpdateBindingsCommand(
      "unbind",
      { agent: "ops", bind: ["telegram:ops"] },
      runtime,
    );
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Bindings are owned by another agent:");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each(["bind", "unbind"] as const)(
    "%s preserves conflict JSON and exit status",
    async (command) => {
      setConfig(conflictConfig);
      const output = jsonRuntime();
      await commands.agentsUpdateBindingsCommand(
        command,
        { agent: "ops", bind: ["telegram:ops"], json: true },
        output,
      );
      expect(writeConfigFileMock).not.toHaveBeenCalled();
      expect(output.writeJson).toHaveBeenCalledExactlyOnceWith(
        {
          agentId: "ops",
          ...(command === "bind"
            ? { added: [], updated: [], skipped: [] }
            : { removed: [], missing: [] }),
          conflicts: ["telegram accountId=ops (agent=main)"],
        },
        2,
      );
      expect(output.error).not.toHaveBeenCalled();
      expect(output.exit).toHaveBeenCalledWith(1);
    },
  );
});
