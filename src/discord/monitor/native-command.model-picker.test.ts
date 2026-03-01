import { ChannelType } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as commandRegistryModule from "../../auto-reply/commands-registry.js";
import type {
  ChatCommandDefinition,
  CommandArgsParsing,
} from "../../auto-reply/commands-registry.types.js";
import type { ModelsProviderData } from "../../auto-reply/reply/commands-models.js";
import * as dispatcherModule from "../../auto-reply/reply/provider-dispatcher.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as globalsModule from "../../globals.js";
import * as timeoutModule from "../../utils/with-timeout.js";
import * as modelPickerPreferencesModule from "./model-picker-preferences.js";
import * as modelPickerModule from "./model-picker.js";
import { createModelsProviderData as createBaseModelsProviderData } from "./model-picker.test-utils.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordModelPickerFallbackSelect,
} from "./native-command.js";
import { createNoopThreadBindingManager, type ThreadBindingManager } from "./thread-bindings.js";

type ModelPickerContext = Parameters<typeof createDiscordModelPickerFallbackButton>[0];
type PickerButton = ReturnType<typeof createDiscordModelPickerFallbackButton>;
type PickerSelect = ReturnType<typeof createDiscordModelPickerFallbackSelect>;
type PickerButtonInteraction = Parameters<PickerButton["run"]>[0];
type PickerButtonData = Parameters<PickerButton["run"]>[1];
type PickerSelectInteraction = Parameters<PickerSelect["run"]>[0];
type PickerSelectData = Parameters<PickerSelect["run"]>[1];

type MockInteraction = {
  user: { id: string; username: string; globalName: string };
  channel: { type: ChannelType; id: string };
  guild: null;
  rawData: { id: string; member: { roles: string[] } };
  values?: string[];
  reply: ReturnType<typeof vi.fn>;
  followUp: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  client: object;
};

function createModelsProviderData(entries: Record<string, string[]>): ModelsProviderData {
  return createBaseModelsProviderData(entries, { defaultProviderOrder: "sorted" });
}

function createModelPickerContext(): ModelPickerContext {
  const cfg = {
    channels: {
      discord: {
        dm: {
          enabled: true,
          policy: "open",
        },
      },
    },
  } as unknown as OpenClawConfig;

  return {
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

function createInteraction(params?: { userId?: string; values?: string[] }): MockInteraction {
  const userId = params?.userId ?? "owner";
  return {
    user: {
      id: userId,
      username: "tester",
      globalName: "Tester",
    },
    channel: {
      type: ChannelType.DM,
      id: "dm-1",
    },
    guild: null,
    rawData: {
      id: "interaction-1",
      member: { roles: [] },
    },
    values: params?.values,
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    update: vi.fn().mockResolvedValue({ ok: true }),
    acknowledge: vi.fn().mockResolvedValue({ ok: true }),
    client: {},
  };
}

function createDefaultModelPickerData(): ModelsProviderData {
  return createModelsProviderData({
    openai: ["gpt-4.1", "gpt-4o"],
    anthropic: ["claude-sonnet-4-5"],
  });
}

function createModelCommandDefinition(): ChatCommandDefinition {
  return {
    key: "model",
    nativeName: "model",
    description: "Switch model",
    textAliases: ["/model"],
    acceptsArgs: true,
    argsParsing: "none" as CommandArgsParsing,
    scope: "native",
  };
}

function mockModelCommandPipeline(modelCommand: ChatCommandDefinition) {
  vi.spyOn(commandRegistryModule, "findCommandByNativeName").mockImplementation((name) =>
    name === "model" ? modelCommand : undefined,
  );
  vi.spyOn(commandRegistryModule, "listChatCommands").mockReturnValue([modelCommand]);
  vi.spyOn(commandRegistryModule, "resolveCommandArgMenu").mockReturnValue(null);
}

function createModelsViewSelectData(): PickerSelectData {
  return {
    cmd: "model",
    act: "model",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1",
  };
}

function createModelsViewSubmitData(): PickerButtonData {
  return {
    cmd: "model",
    act: "submit",
    view: "models",
    u: "owner",
    p: "openai",
    pg: "1",
    mi: "2",
  };
}

async function runSubmitButton(params: {
  context: ModelPickerContext;
  data: PickerButtonData;
  userId?: string;
}) {
  const button = createDiscordModelPickerFallbackButton(params.context);
  const submitInteraction = createInteraction({ userId: params.userId ?? "owner" });
  await button.run(submitInteraction as unknown as PickerButtonInteraction, params.data);
  return submitInteraction;
}

function expectDispatchedModelSelection(params: {
  dispatchSpy: { mock: { calls: Array<[unknown]> } };
  model: string;
  requireTargetSessionKey?: boolean;
}) {
  const dispatchCall = params.dispatchSpy.mock.calls[0]?.[0] as {
    ctx?: {
      CommandBody?: string;
      CommandArgs?: { values?: { model?: string } };
      CommandTargetSessionKey?: string;
    };
  };
  expect(dispatchCall.ctx?.CommandBody).toBe(`/model ${params.model}`);
  expect(dispatchCall.ctx?.CommandArgs?.values?.model).toBe(params.model);
  if (params.requireTargetSessionKey) {
    expect(dispatchCall.ctx?.CommandTargetSessionKey).toBeDefined();
  }
}

function createBoundThreadBindingManager(params: {
  accountId: string;
  threadId: string;
  targetSessionKey: string;
  agentId: string;
}): ThreadBindingManager {
  return {
    accountId: params.accountId,
    getIdleTimeoutMs: () => 24 * 60 * 60 * 1000,
    getMaxAgeMs: () => 0,
    getByThreadId: (threadId: string) =>
      threadId === params.threadId
        ? {
            accountId: params.accountId,
            channelId: "parent-1",
            threadId: params.threadId,
            targetKind: "subagent",
            targetSessionKey: params.targetSessionKey,
            agentId: params.agentId,
            boundBy: "system",
            boundAt: Date.now(),
            lastActivityAt: Date.now(),
            idleTimeoutMs: 24 * 60 * 60 * 1000,
            maxAgeMs: 0,
          }
        : undefined,
    getBySessionKey: () => undefined,
    listBySessionKey: () => [],
    listBindings: () => [],
    touchThread: () => null,
    bindTarget: async () => null,
    unbindThread: () => null,
    unbindBySessionKey: () => [],
    stop: () => {},
  };
}

describe("Discord model picker interactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers distinct fallback ids for button and select handlers", () => {
    const context = createModelPickerContext();
    const button = createDiscordModelPickerFallbackButton(context);
    const select = createDiscordModelPickerFallbackSelect(context);

    expect(button.customId).not.toBe(select.customId);
    expect(button.customId.split(":")[0]).toBe(select.customId.split(":")[0]);
  });

  it("ignores interactions from users other than the picker owner", async () => {
    const context = createModelPickerContext();
    const loadSpy = vi.spyOn(modelPickerModule, "loadDiscordModelPickerData");
    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "intruder" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "back",
      view: "providers",
      u: "owner",
      pg: "1",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.acknowledge).toHaveBeenCalledTimes(1);
    expect(interaction.update).not.toHaveBeenCalled();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("requires submit click before routing selected model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });

    const selectData = createModelsViewSelectData();

    await select.run(selectInteraction as unknown as PickerSelectInteraction, selectData);

    expect(selectInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();

    const submitInteraction = await runSubmitButton({
      context,
      data: createModelsViewSubmitData(),
    });

    expect(submitInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({
      dispatchSpy,
      model: "openai/gpt-4o",
      requireTargetSessionKey: true,
    });
  });

  it("shows timeout status and skips recents write when apply is still processing", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);

    const recordRecentSpy = vi
      .spyOn(modelPickerPreferencesModule, "recordDiscordModelPickerRecentModel")
      .mockResolvedValue();
    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockImplementation(() => new Promise(() => {}) as never);
    const withTimeoutSpy = vi
      .spyOn(timeoutModule, "withTimeout")
      .mockRejectedValue(new Error("timeout"));

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });

    const selectData = createModelsViewSelectData();

    await select.run(selectInteraction as unknown as PickerSelectInteraction, selectData);

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    expect(withTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(submitInteraction.followUp).toHaveBeenCalledTimes(1);
    const followUpPayload = submitInteraction.followUp.mock.calls[0]?.[0] as {
      components?: Array<{ components?: Array<{ content?: string }> }>;
    };
    const followUpText = JSON.stringify(followUpPayload);
    expect(followUpText).toContain("still processing");
    expect(recordRecentSpy).not.toHaveBeenCalled();
  });

  it("clicking Recents button renders recents view", async () => {
    const context = createModelPickerContext();
    const pickerData = createModelsProviderData({
      openai: ["gpt-4.1", "gpt-4o"],
      anthropic: ["claude-sonnet-4-5"],
    });

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);

    const button = createDiscordModelPickerFallbackButton(context);
    const interaction = createInteraction({ userId: "owner" });

    const data: PickerButtonData = {
      cmd: "model",
      act: "recents",
      view: "recents",
      u: "owner",
      p: "openai",
      pg: "1",
    };

    await button.run(interaction as unknown as PickerButtonInteraction, data);

    expect(interaction.update).toHaveBeenCalledTimes(1);
    const updatePayload = interaction.update.mock.calls[0]?.[0];
    expect(updatePayload).toBeDefined();
    expect(updatePayload.components).toBeDefined();
  });

  it("clicking recents model button applies model through /model pipeline", async () => {
    const context = createModelPickerContext();
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    vi.spyOn(modelPickerPreferencesModule, "readDiscordModelPickerRecentModels").mockResolvedValue([
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4-5",
    ]);
    mockModelCommandPipeline(modelCommand);

    const dispatchSpy = vi
      .spyOn(dispatcherModule, "dispatchReplyWithDispatcher")
      .mockResolvedValue({} as never);

    // rs=2 -> first deduped recent (default is anthropic/claude-sonnet-4-5, so openai/gpt-4o remains)
    const submitInteraction = await runSubmitButton({
      context,
      data: {
        cmd: "model",
        act: "submit",
        view: "recents",
        u: "owner",
        pg: "1",
        rs: "2",
      },
    });

    expect(submitInteraction.update).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expectDispatchedModelSelection({ dispatchSpy, model: "openai/gpt-4o" });
  });

  it("verifies model state against the bound thread session", async () => {
    const context = createModelPickerContext();
    context.threadBindings = createBoundThreadBindingManager({
      accountId: "default",
      threadId: "thread-bound",
      targetSessionKey: "agent:worker:subagent:bound",
      agentId: "worker",
    });
    const pickerData = createDefaultModelPickerData();
    const modelCommand = createModelCommandDefinition();

    vi.spyOn(modelPickerModule, "loadDiscordModelPickerData").mockResolvedValue(pickerData);
    mockModelCommandPipeline(modelCommand);
    vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({} as never);
    const verboseSpy = vi.spyOn(globalsModule, "logVerbose").mockImplementation(() => {});

    const select = createDiscordModelPickerFallbackSelect(context);
    const selectInteraction = createInteraction({
      userId: "owner",
      values: ["gpt-4o"],
    });
    selectInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const selectData = createModelsViewSelectData();
    await select.run(selectInteraction as unknown as PickerSelectInteraction, selectData);

    const button = createDiscordModelPickerFallbackButton(context);
    const submitInteraction = createInteraction({ userId: "owner" });
    submitInteraction.channel = {
      type: ChannelType.PublicThread,
      id: "thread-bound",
    };
    const submitData = createModelsViewSubmitData();

    await button.run(submitInteraction as unknown as PickerButtonInteraction, submitData);

    const mismatchLog = verboseSpy.mock.calls.find((call) =>
      String(call[0] ?? "").includes("model picker override mismatch"),
    )?.[0];
    expect(mismatchLog).toContain("session key agent:worker:subagent:bound");
  });
});
