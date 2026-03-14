import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { HandleCommandsParams } from "./commands-types.js";

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: gatewayMocks.callGateway,
}));

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  ]),
}));

const { handleModelsCommand } = await import("./commands-models.js");
const { handleApproveCommand } = await import("./commands-approve.js");

function makeParams(
  commandBodyNormalized: string,
  overrides?: Partial<HandleCommandsParams>,
): HandleCommandsParams {
  return {
    cfg: {
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
        },
      },
    } as OpenClawConfig,
    directives: {},
    elevated: {
      enabled: false,
      allowed: false,
      failures: [],
    },
    sessionKey: "agent:archie:zulip:stream:ops:topic:deploy",
    workspaceDir: "/tmp/openclaw-workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "normal",
    resolvedReasoningLevel: "normal",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-4.1-mini",
    contextTokens: 0,
    isGroup: false,
    sessionEntry: undefined,
    previousSessionEntry: undefined,
    sessionStore: undefined,
    storePath: undefined,
    sessionScope: undefined,
    rootCtx: undefined,
    agentId: "archie",
    agentDir: undefined,
    resolvedThinkLevel: undefined,
    resolvedElevatedLevel: undefined,
    skillCommands: undefined,
    ...overrides,
    command: {
      surface: "zulip",
      channel: "zulip",
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      senderId: "42",
      rawBodyNormalized: commandBodyNormalized,
      commandBodyNormalized,
      from: "zulip:42",
      to: "dm:42",
      ...(overrides?.command ?? {}),
    },
    ctx: {
      Surface: "zulip",
      AccountId: "default",
      CommandSource: "text",
      ...(overrides?.ctx ?? {}),
    } as HandleCommandsParams["ctx"],
  };
}

describe("shared Zulip command handlers", () => {
  beforeEach(() => {
    gatewayMocks.callGateway.mockReset();
    gatewayMocks.callGateway.mockResolvedValue({ ok: true });
  });

  it("derives invoker ACLs for shared Zulip /models", async () => {
    const result = await handleModelsCommand(makeParams("/models"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.channelData?.zulip).toMatchObject({
      heading: "Model Providers",
      buttons: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            text: "anthropic (1)",
            callback_data: "mdl_list_anthropic_1",
            allowed_users: [42],
          }),
          expect.objectContaining({
            text: "openai (2)",
            callback_data: "mdl_list_openai_1",
            allowed_users: [42],
          }),
        ]),
      ]),
    });
  });

  it("derives invoker ACLs for shared Zulip /models <provider>", async () => {
    const result = await handleModelsCommand(makeParams("/models openai"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Models (openai");
    expect(result?.reply?.channelData?.zulip).toMatchObject({
      heading: "openai models",
      buttons: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("gpt-4.1-mini ✓"),
            allowed_users: [42],
          }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({
            text: "<< Back",
            callback_data: "mdl_back",
            allowed_users: [42],
          }),
        ]),
      ]),
    });
  });

  it("submits shared Zulip /approve through the gateway", async () => {
    const result = await handleApproveCommand(makeParams("/approve req-123 allow-once"), true);

    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      method: "exec.approval.resolve",
      params: { id: "req-123", decision: "allow-once" },
      clientName: "gateway-client",
      clientDisplayName: "Chat approval (zulip:42)",
      mode: "backend",
    });
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "✅ Exec approval allow-once submitted for req-123." },
    });
    expect(result?.reply?.channelData).toBeUndefined();
  });

  it("blocks unauthorized shared Zulip /approve before calling the gateway", async () => {
    const result = await handleApproveCommand(
      makeParams("/approve req-123 allow-once", {
        command: {
          isAuthorizedSender: false,
        } as Partial<HandleCommandsParams["command"]>,
      }),
      true,
    );

    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(result).toEqual({ shouldContinue: false });
  });
});
