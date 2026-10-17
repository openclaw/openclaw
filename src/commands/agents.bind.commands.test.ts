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
type UpdateOptions = Parameters<typeof commands.agentsUpdateBindingsCommand>[1];
const update = (operation: "bind" | "unbind", options: UpdateOptions, output = runtime) =>
  commands.agentsUpdateBindingsCommand(operation, options, output);
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
const expectNoCalls = (...mocks: ReturnType<typeof vi.fn>[]) => {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
};
const unknownAgent = (id: string) =>
  `Agent "${id}" not found. Run openclaw agents list to see configured agents.`;
const explicitAgents = { ownership: "explicit" as const, entries: { main: {}, ops: {} } };

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

  it("uses the persisted default ops for bind and unbind", async () => {
    const agentId = "ops";
    const config: OpenClawConfig = {
      agents: {
        ...explicitAgents,
        defaults: { systemAgent: { agentId } },
      },
    };
    setConfig(config);
    await update("bind", { bind: ["telegram:work"] });
    const bound = { ...config, bindings: [route("telegram", "work", agentId)] };
    expect(writeConfigFileMock).toHaveBeenLastCalledWith(bound);

    setConfig(bound);
    await update("unbind", { bind: ["telegram:work"] });
    expect(writeConfigFileMock).toHaveBeenLastCalledWith({ ...config, bindings: undefined });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("matches normalized account identities for conflicts, repeats, and removal", async () => {
    const config: OpenClawConfig = {
      agents: explicitAgents,
      bindings: [route("telegram", "Work", "ops")],
    };
    setConfig(config);
    const output = jsonRuntime();
    await update("bind", { agent: "main", bind: ["telegram:work"], json: true }, output);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(output.exit).toHaveBeenCalledWith(1);
    expect(output.writeJson).toHaveBeenLastCalledWith(
      expect.objectContaining({ conflicts: ["telegram accountId=work (agent=ops)"] }),
      2,
    );

    await update("bind", { agent: "ops", bind: ["telegram:WORK"] });
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    await update("unbind", { agent: "ops", bind: ["telegram:work"] });
    expect(writeConfigFileMock).toHaveBeenLastCalledWith({ ...config, bindings: undefined });
  });

  it("binds a mixed batch using one manifest inventory per invocation", async () => {
    await update("bind", {
      bind: ["telegram", "whatsapp", "signal", "external-chat:work", "external-chat:home"],
    });
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
    await expect(update("bind", { bind: ["external-chat:next"] })).rejects.toMatchObject({
      message: expect.stringContaining('Unknown channel "external-chat"'),
    });
    expect(pluginRegistryMocks.listPluginContributionIds).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["bind", { agent: "агент✨", bind: ["telegram"] }, unknownAgent("агент✨")],
    ["list", { agent: "ghost" }, unknownAgent("ghost")],
    ["bind", {}, "Provide at least one --bind <channel[:accountId]>."],
    [
      "bind",
      { bind: ["telegram:", "telegram:work:extra", "definitely-not-a-channel"] },
      [
        'Invalid binding "telegram:". Account id is empty. Use <channel>:<account>, for example telegram:default.',
        'Invalid binding "telegram:work:extra". Account id cannot contain ":". Use <channel>:<account>, for example telegram:default.',
        'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
      ].join("\n"),
    ],
    ["unbind", { all: true, bind: ["telegram"] }, "Use either --all or --bind, not both."],
  ] satisfies Array<["bind" | "list" | "unbind", UpdateOptions, string]>)(
    "rejects %s %j before mutation",
    async (command, input, message) => {
      const options = { ...input, json: true };
      const execution =
        command === "list"
          ? commands.agentsBindingsCommand(options, runtime)
          : update(command, options);
      await expect(execution).rejects.toMatchObject({
        name: "ExpectedCliError",
        message,
        humanOutput: message,
        machineOutput: message,
      });
      expectNoCalls(runtime.error, runtime.exit, writeConfigFileMock);
    },
  );

  it("unbinds all routes for one agent while preserving the others", async () => {
    setConfig({ ...conflictConfig, bindings: [route("matrix"), route("telegram", "work", "ops")] });
    await update("unbind", { agent: "ops", all: true });
    expect(writeConfigFileMock).toHaveBeenCalledExactlyOnceWith({
      ...conflictConfig,
      bindings: [route("matrix")],
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports empty unbind-all as JSON without writes or text logs", async () => {
    const output = jsonRuntime();
    await update("unbind", { agent: "main", all: true, json: true }, output);
    expectNoCalls(writeConfigFileMock, output.log, output.exit);
    expect(output.writeJson).toHaveBeenCalledExactlyOnceWith(
      { agentId: "main", removed: [], missing: [], conflicts: [] },
      2,
    );
  });

  it("reports human unbind ownership conflicts without writing", async () => {
    setConfig(conflictConfig);
    await update("unbind", { agent: "ops", bind: ["telegram:ops"] });
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Bindings are owned by another agent:");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
