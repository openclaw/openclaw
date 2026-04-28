import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import type { PluginCommandContext } from "../../plugins/types.js";
import type { MsgContext } from "../templating.js";
import { handleDiagnosticsCommand } from "./commands-diagnostics.js";
import type { HandleCommandsParams } from "./commands-types.js";

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
  expect(
    registerPluginCommand(
      "codex",
      {
        name: "codex",
        description: "Codex command",
        acceptsArgs: true,
        handler: commandHandler,
        ownership: "reserved",
      },
      { allowReservedCommandNames: true },
    ),
  ).toEqual({ ok: true });
  return { calls, commandHandler };
}

afterEach(() => {
  clearPluginCommands();
});

describe("diagnostics command", () => {
  it("shows the Gateway diagnostics preamble without Codex upload details by default", async () => {
    const result = await handleDiagnosticsCommand(buildDiagnosticsParams("/diagnostics"), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
      "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    );
    expect(result?.reply?.text).toContain("https://docs.openclaw.ai/gateway/diagnostics");
    expect(result?.reply?.text).toContain("openclaw gateway diagnostics export");
    expect(result?.reply?.text).toContain("Do not approve diagnostics with an allow-all rule.");
    expect(result?.reply?.text).not.toContain("OpenAI Codex harness");
  });

  it("offers the Codex feedback upload confirmation for Codex harness sessions", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest(async () => null);
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
    const commandHandler = vi.fn(async (ctx: PluginCommandContext) => ({
      text: `confirmed ${ctx.args}`,
    }));
    registerPluginCommand(
      "codex",
      {
        name: "codex",
        description: "Codex command",
        acceptsArgs: true,
        handler: commandHandler,
        ownership: "reserved",
      },
      { allowReservedCommandNames: true },
    );

    const result = await handleDiagnosticsCommand(
      buildDiagnosticsParams("/diagnostics confirm abc123def456"),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(commandHandler).toHaveBeenCalledTimes(1);
    expect(result?.reply?.text).toBe("confirmed diagnostics confirm abc123def456");
  });

  it("does not delegate diagnostics to a non-Codex plugin command", async () => {
    const commandHandler = vi.fn(async () => ({ text: "wrong codex" }));
    registerPluginCommand(
      "third-party",
      {
        name: "codex",
        description: "Fake Codex command",
        acceptsArgs: true,
        handler: commandHandler,
        ownership: "reserved",
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
