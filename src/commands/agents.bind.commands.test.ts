import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import {
  loadFreshAgentsBindCommandModuleForTest,
  readConfigFileSnapshotMock,
  resetAgentsBindTestHarness,
  runtime,
  writeConfigFileMock,
} from "./agents.bind.test-support.js";
import { baseConfigSnapshot } from "./test-runtime-config-helpers.js";

const listContributions = vi.hoisted(() => vi.fn(() => ["external-chat"]));
// mock-isolation: Supply synthetic channel contributions without discovering installed plugins.
vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  listPluginContributionIds: listContributions,
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
const update = (operation: "bind" | "unbind" | "list", options: UpdateOptions) =>
  operation === "list"
    ? commands.agentsBindingsCommand(options)
    : commands.agentsUpdateBindingsCommand(operation, options);
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
const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
const expectNoCalls = (...mocks: ReturnType<typeof vi.fn>[]) =>
  mocks.forEach((mock) => expect(mock).not.toHaveBeenCalled());
const unknownAgent = (id: string) =>
  `Agent "${id}" not found. Run openclaw agents list to see configured agents.`;
const explicitAgents = { ownership: "explicit" as const, entries: { main: {}, ops: {} } };
type Rejection = [Parameters<typeof update>[0], UpdateOptions, string];

describe("agents bind/unbind commands", () => {
  afterAll(() => vi.restoreAllMocks());
  beforeAll(async () => {
    commands = await loadFreshAgentsBindCommandModuleForTest();
  });
  beforeEach(() => {
    json.mockClear();
    resetAgentsBindTestHarness();
    listContributions.mockReset().mockReturnValue(["external-chat"]);
    setConfig({});
  });

  it("lists routing bindings without plugin validation", async () => {
    setConfig({ bindings: [route("matrix"), route("telegram", "work", "ops")] });
    await update("list", {});
    expect(readConfigFileSnapshotMock).toHaveBeenCalledWith({ skipPluginValidation: true });
    expect(runtime.log).toHaveBeenCalledWith(
      "Routing bindings:\n- main <- matrix\n- ops <- telegram accountId=work",
    );
  });

  it("uses the persisted default ops for bind and unbind", async () => {
    const config: OpenClawConfig = {
      agents: { ...explicitAgents, defaults: { systemAgent: { agentId: "ops" } } },
    };
    setConfig(config);
    await update("bind", { bind: ["telegram:work"] });
    const bound = { ...config, bindings: [route("telegram", "work", "ops")] };
    expect(writeConfigFileMock).toHaveBeenLastCalledWith(bound);

    setConfig(bound);
    await update("unbind", { bind: ["telegram:work"] });
    expect(writeConfigFileMock).toHaveBeenLastCalledWith({ ...config, bindings: undefined });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("matches channel case-insensitively for bind conflicts and unbind removal (gh-184636)", async () => {
    const config = {
      agents: explicitAgents,
      bindings: [{ ...route("telegram", "default", "ops"), match: { channel: "Telegram" } }],
    };
    setConfig(config);

    // bind for another agent on the same channel: cased route must conflict
    await update("bind", { agent: "main", bind: ["telegram:default"], json: true });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();

    // unbind for the owning agent: cased route must be found and removed
    setConfig({
      agents: explicitAgents,
      bindings: [{ ...route("telegram", "default", "ops"), match: { channel: "Telegram" } }],
    });
    await update("unbind", { agent: "ops", bind: ["telegram:default"] });
    const written = writeConfigFileMock.mock.calls.at(-1)?.[0] as OpenClawConfig;
    expect(written.bindings ?? []).toEqual([]);
  });

  it("matches normalized account identities for conflicts, repeats, and removal", async () => {
    const config = { agents: explicitAgents, bindings: [route("telegram", "Work", "ops")] };
    setConfig(config);
    await update("bind", { agent: "main", bind: ["telegram:work"], json: true });
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(json.mock.lastCall).toEqual([
      expect.objectContaining({ conflicts: ["telegram accountId=work (agent=ops)"] }),
      2,
    ]);

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
    expect(listContributions).toHaveBeenCalledOnce();
    expect(runtime.exit).not.toHaveBeenCalled();
    listContributions.mockReturnValueOnce([]);
    await expect(update("bind", { bind: ["external-chat:next"] })).rejects.toMatchObject({
      message: expect.stringContaining('Unknown channel "external-chat"'),
    });
    expect(listContributions).toHaveBeenCalledTimes(2);
  });

  it.each<Rejection>([
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
  ])("rejects %s %j before mutation", async (command, input, message) => {
    const options = { ...input, json: true };
    await expect(update(command, options)).rejects.toMatchObject({
      name: "ExpectedCliError",
      message,
      humanOutput: message,
      machineOutput: message,
    });
    expectNoCalls(runtime.error, runtime.exit, writeConfigFileMock);
  });

  it("unbinds all routes for one agent while preserving the others", async () => {
    setConfig({ ...conflictConfig, bindings: [route("matrix"), route("telegram", "work", "ops")] });
    await update("unbind", { agent: "ops", all: true });
    const remaining = { ...conflictConfig, bindings: [route("matrix")] };
    expect(writeConfigFileMock).toHaveBeenCalledExactlyOnceWith(remaining);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports empty unbind-all as JSON without writes or text logs", async () => {
    await update("unbind", { agent: "main", all: true, json: true });
    expectNoCalls(writeConfigFileMock, runtime.log, runtime.exit);
    expect(json.mock.calls).toEqual([
      [{ agentId: "main", removed: [], missing: [], conflicts: [] }, 2],
    ]);
  });

  it("reports human unbind ownership conflicts without writing", async () => {
    setConfig(conflictConfig);
    await update("unbind", { agent: "ops", bind: ["telegram:ops"] });
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith("Bindings are owned by another agent:");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
