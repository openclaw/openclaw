import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { createPluginRegistry, type PluginRecord } from "../../plugins/registry.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { PluginCommandContext } from "../../plugins/types.js";
import type { MsgContext } from "../templating.js";
import { createDiagnosticsCommandHandler } from "./commands-diagnostics.js";
import type { HandleCommandsParams } from "./commands-types.js";

type ExecCall = {
  defaults: unknown;
  params: unknown;
};

function buildDiagnosticsParams(
  commandBodyNormalized: string,
  overrides: Partial<HandleCommandsParams> = {},
): HandleCommandsParams {
  return {
    cfg: { commands: { text: true } } as OpenClawConfig,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      AccountId: "account-1",
      MessageThreadId: "thread-1",
    } as MsgContext,
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "user-1",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
      from: "user-1",
      to: "bot",
    },
    sessionKey: "agent:main:whatsapp:direct:user-1",
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    ...overrides,
  } as HandleCommandsParams;
}

function createBundledPluginRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    source: `bundled:${id}`,
    rootDir: `/bundled/${id}`,
    origin: "bundled",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  } as PluginRecord;
}

function registerHostTrustedReservedCommandForTest(
  command: Parameters<typeof registerPluginCommand>[1],
) {
  const pluginRegistry = createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
  pluginRegistry.registerCommand(createBundledPluginRecord(command.name), command);
}

function registerCodexDiagnosticsCommandForTest(
  handler: (ctx: PluginCommandContext) => Promise<unknown>,
) {
  const calls: PluginCommandContext[] = [];
  const commandHandler = vi.fn(async (ctx: PluginCommandContext) => {
    calls.push(ctx);
    await handler(ctx);
    return {
      text: [
        "Codex runtime thread detected.",
        "Thread: codex-thread-1",
        "To send: /codex diagnostics confirm abc123def456",
        "To cancel: /codex diagnostics cancel abc123def456",
      ].join("\n"),
      interactive: {
        blocks: [
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "Send diagnostics",
                value: "/codex diagnostics confirm abc123def456",
                style: "danger" as const,
              },
              {
                label: "Cancel",
                value: "/codex diagnostics cancel abc123def456",
                style: "secondary" as const,
              },
            ],
          },
        ],
      },
    };
  });
  registerHostTrustedReservedCommandForTest({
    name: "codex",
    description: "Codex command",
    acceptsArgs: true,
    handler: commandHandler,
    ownership: "reserved",
  });
  return { calls, commandHandler };
}

function createDiagnosticsHandlerForTest() {
  const execCalls: ExecCall[] = [];
  const createExecTool = vi.fn((defaults: unknown) => ({
    execute: vi.fn(async (_toolCallId: string, params: unknown) => {
      execCalls.push({ defaults, params });
      return {
        content: [
          {
            type: "text" as const,
            text: "Exec approval pending. Allowed decisions: allow-once, deny.",
          },
        ],
        details: {
          status: "approval-pending" as const,
          approvalId: "approval-1",
          approvalSlug: "diag-approval",
          expiresAtMs: Date.now() + 60_000,
          allowedDecisions: ["allow-once", "deny"] as const,
          host: "gateway" as const,
          command: "openclaw gateway diagnostics export --json",
          cwd: "/tmp",
        },
      };
    }),
  }));
  return {
    execCalls,
    handleDiagnosticsCommand: createDiagnosticsCommandHandler({
      createExecTool: createExecTool as never,
    }),
  };
}

afterEach(() => {
  clearPluginCommands();
});

describe("diagnostics command", () => {
  it("shows the Gateway diagnostics preamble without Codex upload details by default", async () => {
    const { execCalls, handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const result = await handleDiagnosticsCommand(buildDiagnosticsParams("/diagnostics"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
      "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    );
    expect(result?.reply?.text).toContain("https://docs.openclaw.ai/gateway/diagnostics");
    expect(result?.reply?.text).toContain("openclaw gateway diagnostics export --json");
    expect(result?.reply?.text).toContain("requested");
    expect(result?.reply?.text).toContain("do not use allow-all");
    expect(result?.reply?.text).toContain("Allowed decisions: allow-once, deny");
    expect(result?.reply?.text).not.toContain("OpenAI Codex harness");
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.defaults).toMatchObject({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "diagnostics",
    });
    expect(execCalls[0]?.params).toMatchObject({
      command: "openclaw gateway diagnostics export --json",
      security: "allowlist",
      ask: "always",
    });
  });

  it("offers the Codex feedback upload confirmation for Codex harness sessions", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest(async () => null);
    const { handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics flaky tool call", {
        sessionEntry: {
          sessionId: "session-1",
          sessionFile: "/tmp/session.jsonl",
          updatedAt: 1,
          agentHarnessId: "codex",
        },
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toBe("diagnostics flaky tool call");
    expect(calls[0]?.senderIsOwner).toBe(true);
    expect(calls[0]?.sessionFile).toBe("/tmp/session.jsonl");
    expect(calls[0]?.diagnosticsSessions).toEqual([
      expect.objectContaining({
        agentHarnessId: "codex",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        channel: "whatsapp",
        accountId: "account-1",
      }),
    ]);
    expect(result?.reply?.text).toContain("OpenAI Codex harness:");
    expect(result?.reply?.text).toContain("To send: /diagnostics confirm abc123def456");
    expect(result?.reply?.text).not.toContain("/codex diagnostics confirm");
    expect(result?.reply?.interactive).toMatchObject({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              value: "/diagnostics confirm abc123def456",
              style: "danger",
            },
            {
              value: "/diagnostics cancel abc123def456",
            },
          ],
        },
      ],
    });
  });

  it("requires an owner for diagnostics", async () => {
    const { handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics", {
        command: {
          ...buildDiagnosticsParams("/diagnostics").command,
          senderIsOwner: false,
        },
      }),
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
  });

  it("routes confirmations back to the Codex diagnostics handler without repeating the preamble", async () => {
    const { handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const commandHandler = vi.fn(async (ctx: PluginCommandContext) => ({
      text: `confirmed ${ctx.args}`,
    }));
    registerHostTrustedReservedCommandForTest({
      name: "codex",
      description: "Codex command",
      acceptsArgs: true,
      handler: commandHandler,
      ownership: "reserved",
    });

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics confirm abc123def456"),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(result?.reply?.text).toBe("confirmed diagnostics confirm abc123def456");
  });

  it("does not delegate diagnostics to a non-Codex plugin command", async () => {
    const { handleDiagnosticsCommand } = createDiagnosticsHandlerForTest();
    const commandHandler = vi.fn(async () => ({ text: "wrong codex" }));
    registerPluginCommand(
      "third-party",
      {
        name: "codex",
        description: "Fake Codex command",
        acceptsArgs: true,
        handler: commandHandler,
      },
      { allowReservedCommandNames: true },
    );

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics confirm abc123def456"),
      true,
    );

    expect(result?.reply?.text).toBe(
      "No Codex diagnostics confirmation handler is available for this session.",
    );
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
