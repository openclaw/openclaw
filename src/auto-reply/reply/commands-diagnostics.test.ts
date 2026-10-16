// Tests diagnostics command output and runtime diagnostic toggles.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as sessionReads from "../../config/sessions/session-entry-read-runtime.js";
import type {
  LegacyInteractiveReply,
  MessagePresentationAction,
} from "../../interactive/payload.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { createBundledPluginRecord } from "../../plugins/status.test-fixtures.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext } from "../../plugins/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";

type PluginCommandHandler = OpenClawPluginCommandDefinition["handler"];
import type { MsgContext } from "../templating.js";
import { handleDiagnosticsCommand } from "./commands-diagnostics.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const diagnosticsCommandMocks = vi.hoisted(() => ({
  createExecTool: vi.fn(),
  deliverPrivateCommandReply:
    vi.fn<typeof import("./commands-private-route.js").deliverPrivateCommandReply>(),
  resolvePrivateCommandRouteTargets:
    vi.fn<typeof import("./commands-private-route.js").resolvePrivateCommandRouteTargets>(),
}));

vi.mock("../../agents/bash-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/bash-tools.js")>()),
  createExecTool: diagnosticsCommandMocks.createExecTool,
}));

vi.mock("./commands-private-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands-private-route.js")>()),
  deliverPrivateCommandReply: diagnosticsCommandMocks.deliverPrivateCommandReply,
  resolvePrivateCommandRouteTargets: diagnosticsCommandMocks.resolvePrivateCommandRouteTargets,
}));

type ExecCall = { defaults: ExecDefaults; params: ExecParams };

type ExecDefaults = Omit<ExecToolDefaults, "approvalFollowup"> & {
  approvalFollowup?: () => Promise<string | undefined>;
};

type ExecParams = { ask?: string; command?: string };

type PrivateDiagnosticsReply = {
  targets: Array<{ channel: string; to: string; accountId?: string | null }>;
  text?: string;
};

function requireExecCall(execCalls: ExecCall[], index = 0) {
  return expectDefined(execCalls[index], `exec call ${index}`);
}

function buildDiagnosticsParams(
  commandBodyNormalized: string,
  overrides: Partial<HandleCommandsParams> = {},
): HandleCommandsParams {
  return commandFixture(
    commandBodyNormalized,
    {
      cfg: { commands: { text: true } },
      ctx: {
        Provider: "whatsapp",
        Surface: "whatsapp",
        CommandSource: "text",
        AccountId: "account-1",
        MessageThreadId: "thread-1",
      } as MsgContext,
      agentId: undefined,
      sessionEntry: undefined,
      sessionKey: "agent:main:whatsapp:direct:user-1",
      workspaceDir: "/tmp",
      ...overrides,
    },
    {
      senderId: "user-1",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      from: "user-1",
    },
  );
}

function runDiagnostics(...args: Parameters<typeof buildDiagnosticsParams>) {
  return handleDiagnosticsCommand(buildDiagnosticsParams(...args), true);
}

function registerCodexHandler(handler: PluginCommandHandler) {
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
  pluginRegistry.registerCommand(createBundledPluginRecord("codex"), {
    name: "codex",
    description: "Codex command",
    acceptsArgs: true,
    handler,
    ownership: "reserved",
  });
  setActivePluginRegistry(pluginRegistry.registry);
}

function sessionEntry(
  sessionId = "session-1",
  sessionFile = "/tmp/session.jsonl",
  overrides: Partial<NonNullable<HandleCommandsParams["sessionEntry"]>> = {},
) {
  return { sessionId, sessionFile, updatedAt: 1, ...overrides };
}

function interactiveReply(action: MessagePresentationAction): LegacyInteractiveReply {
  return {
    blocks: [
      { type: "buttons", buttons: [{ label: "Continue", action }] },
      { type: "select", options: [{ label: "Continue", action }] },
    ],
  };
}

function registerCodexDiagnosticsCommandForTest() {
  const calls: PluginCommandContext[] = [];
  const commandHandler = vi.fn<PluginCommandHandler>(async (ctx) => {
    calls.push(ctx);
    if (ctx.diagnosticsPreviewOnly) {
      return {
        text: [
          "Codex runtime thread detected.",
          "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
        ].join("\n"),
      };
    }
    if (ctx.diagnosticsUploadApproved) {
      return {
        text: "Codex diagnostics sent to OpenAI servers:",
      };
    }
    throw new Error("expected diagnostics preview or approved upload");
  });
  registerCodexHandler(commandHandler);
  return { calls, commandHandler };
}

function createDiagnosticsHandlerForTest(
  options: {
    privateTargets?: Array<{ channel: string; to: string; accountId?: string | null }>;
    deliveryOutcome?: Awaited<
      ReturnType<typeof diagnosticsCommandMocks.deliverPrivateCommandReply>
    >;
    execResult?: {
      content: Array<{ type: "text"; text: string }>;
      details?: { status: string; [key: string]: unknown };
    };
  } = {},
) {
  diagnosticsCommandMocks.createExecTool.mockReset();
  diagnosticsCommandMocks.deliverPrivateCommandReply.mockReset();
  diagnosticsCommandMocks.resolvePrivateCommandRouteTargets.mockReset();
  const execCalls: ExecCall[] = [];
  const privateReplies: PrivateDiagnosticsReply[] = [];
  diagnosticsCommandMocks.createExecTool.mockImplementation((defaults: ExecDefaults) => ({
    execute: vi.fn(async (_toolCallId: string, params: ExecParams) => {
      execCalls.push({ defaults, params });
      return (
        options.execResult ?? {
          content: [],
          details: { status: "approval-pending" },
        }
      );
    }),
  }));
  diagnosticsCommandMocks.resolvePrivateCommandRouteTargets.mockResolvedValue(
    options.privateTargets ?? [],
  );
  diagnosticsCommandMocks.deliverPrivateCommandReply.mockImplementation(
    async ({ targets, reply }) => {
      privateReplies.push({ targets, text: reply.text });
      return options.deliveryOutcome ?? "delivered";
    },
  );
  return {
    execCalls,
    privateReplies,
  };
}

afterEach(() => {
  clearPluginCommands();
});

describe("diagnostics command", () => {
  it("uses the originating Telegram route for native diagnostics followups", async () => {
    const { execCalls } = createDiagnosticsHandlerForTest();
    const params = buildDiagnosticsParams("/diagnostics", {
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:8460800771",
        From: "telegram:8460800771",
        To: "slash:8460800771",
        CommandSource: "native",
        AccountId: "account-1",
      } as MsgContext,
      sessionKey: "agent:main:telegram:slash:8460800771",
    });
    Object.assign(params.command, {
      senderId: "8460800771",
      channel: "telegram",
      channelId: "telegram",
      surface: "telegram",
      from: "telegram:8460800771",
      to: "slash:8460800771",
    });

    await handleDiagnosticsCommand(params, true);

    expect(execCalls).toHaveLength(1);
    const execCall = requireExecCall(execCalls);
    expect(execCall.defaults).toMatchObject({
      messageProvider: "telegram",
      currentChannelId: "telegram:8460800771",
      accountId: "account-1",
    });
  });

  it("falls back to a visible reply when approval cannot be queued", async () => {
    const { execCalls } = createDiagnosticsHandlerForTest({
      execResult: {
        content: [{ type: "text", text: "no interactive approval client" }],
        details: { status: "approval-unavailable" },
      },
    });
    const result = await runDiagnostics("/diagnostics");

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
      "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    );
    expect(result?.reply?.text).toContain("https://docs.openclaw.ai/gateway/diagnostics");
    expect(result?.reply?.text).toContain("no interactive approval client");
    expect(execCalls).toHaveLength(1);
  });

  it("wraps Codex feedback upload into the Gateway diagnostics approval", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest();
    const { execCalls } = createDiagnosticsHandlerForTest();
    const params = buildDiagnosticsParams("/diagnostics flaky tool call", {
      sessionEntry: sessionEntry("session-1", "/tmp/session.jsonl", { agentHarnessId: "codex" }),
    });
    params.ctx.ApprovalReviewerDeviceId = "device-diagnostics-reviewer";
    const result = await handleDiagnosticsCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(calls).toMatchObject([
      {
        args: "diagnostics flaky tool call",
        diagnosticsPreviewOnly: true,
        senderIsOwner: true,
        sessionFile: "agent:main:whatsapp:direct:user-1",
        diagnosticsSessions: [
          {
            agentHarnessId: "codex",
            sessionId: "session-1",
            sessionFile: "agent:main:whatsapp:direct:user-1",
            channel: "whatsapp",
            accountId: "account-1",
          },
        ],
      },
    ]);
    expect(execCalls).toHaveLength(1);
    const { defaults, params: execParams } = requireExecCall(execCalls);
    expect(defaults).toMatchObject({
      host: "gateway",
      security: "allowlist",
      ask: "always",
      trigger: "diagnostics",
      approvalReviewerDeviceId: "device-diagnostics-reviewer",
      approvalFollowupMode: "direct",
    });
    expect(execParams.ask).toBe("always");
    expect(defaults.approvalWarningText).toContain(
      "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    );
    expect(defaults.approvalWarningText).toContain("OpenAI Codex harness:");
    expect(defaults.approvalWarningText).toContain(
      "Approving diagnostics will also send this thread's feedback bundle to OpenAI servers.",
    );
    expect(defaults.approvalWarningText).not.toContain("To send:");
    expect(defaults.approvalWarningText).not.toContain("/codex diagnostics confirm");
    expect(defaults.approvalFollowupText).toBeUndefined();

    await expect(defaults.approvalFollowup?.()).resolves.toContain(
      "Codex diagnostics sent to OpenAI servers:",
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.diagnosticsUploadApproved).toBe(true);
  });

  it("passes canonical session identities to Codex diagnostics when harness metadata is stale", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest();
    const { execCalls } = createDiagnosticsHandlerForTest();
    const result = await runDiagnostics("/diagnostics", {
      sessionKey: "agent:main:telegram:direct:user-1",
      sessionEntry: sessionEntry("telegram-session", "/tmp/telegram.jsonl"),
      sessionStore: {
        "agent:main:telegram:direct:user-1": sessionEntry(
          "telegram-session",
          "/tmp/telegram.jsonl",
        ),
        "agent:main:discord:channel:123": {
          sessionId: "discord-session",
          sessionFile: "/tmp/discord.jsonl",
          updatedAt: 2,
          delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
        },
      },
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(calls).toMatchObject([
      {
        diagnosticsSessions: [
          {
            sessionKey: "agent:main:telegram:direct:user-1",
            sessionId: "telegram-session",
            sessionFile: "agent:main:telegram:direct:user-1",
            channel: "whatsapp",
          },
          {
            sessionKey: "agent:main:discord:channel:123",
            sessionId: "discord-session",
            sessionFile: "agent:main:discord:channel:123",
            channel: "discord",
          },
        ],
      },
    ]);
    expect(requireExecCall(execCalls).defaults.approvalWarningText).toContain(
      "OpenAI Codex harness:",
    );
  });

  it("loads diagnostics inventory after authorization when the reply view contains one row", async () => {
    await withOpenClawTestState({ label: "diagnostics-session-inventory" }, async (state) => {
      const storePath = path.join(state.sessionsDir("main"), "sessions.json");
      const sessionKey = "agent:main:whatsapp:direct:user-1";
      const otherKey = "agent:main:discord:channel:123";
      const current = { sessionId: "active-session", updatedAt: Date.now() };
      await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, current);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: otherKey, storePath },
        {
          sessionId: "other-session",
          updatedAt: Date.now(),
          agentHarnessId: "codex",
          delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
          skillsSnapshot: { prompt: "unrelated diagnostics prompt ".repeat(4096), skills: [] },
        },
      );
      const { calls } = registerCodexDiagnosticsCommandForTest();
      createDiagnosticsHandlerForTest();
      const params = buildDiagnosticsParams("/diagnostics", {
        agentId: "main",
        sessionKey,
        sessionEntry: current,
        sessionStore: { [sessionKey]: current },
        storePath,
      });
      const reads = vi.spyOn(sessionReads, "readSessionEntrySummariesInWorker");
      try {
        await handleDiagnosticsCommand(
          { ...params, command: { ...params.command, senderIsOwner: false } },
          true,
        );
        expect(reads).not.toHaveBeenCalled();
        expect(calls).toHaveLength(0);
        await handleDiagnosticsCommand(params, true);
        expect(calls[0]?.diagnosticsSessions).toEqual([
          expect.objectContaining({ sessionKey, sessionId: "active-session" }),
          expect.objectContaining({
            sessionKey: otherKey,
            sessionId: "other-session",
            agentHarnessId: "codex",
            channel: "discord",
          }),
        ]);
      } finally {
        reads.mockRestore();
      }
    });
  });

  it("omits the Codex section for ordinary sessions without Codex targets", async () => {
    registerCodexHandler(
      vi.fn(async () => ({
        text: "No Codex thread is attached to this OpenClaw session yet.",
      })),
    );
    const { execCalls } = createDiagnosticsHandlerForTest();

    await runDiagnostics("/diagnostics", {
      sessionEntry: sessionEntry("ordinary-session", "/tmp/ordinary.jsonl"),
    });

    expect(requireExecCall(execCalls).defaults.approvalWarningText).not.toContain(
      "OpenAI Codex harness:",
    );
  });

  it.each([true, false])(
    "requires a private diagnostics approval route (available=%s)",
    async (available) => {
      const { calls } = registerCodexDiagnosticsCommandForTest();
      const { execCalls, privateReplies } = createDiagnosticsHandlerForTest({
        privateTargets: available
          ? [
              { channel: "telegram", to: "owner-dm", accountId: "account-1" },
              { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
            ]
          : [],
      });
      const result = await runDiagnostics(
        available ? "/diagnostics flaky tool call" : "/diagnostics",
        {
          isGroup: true,
          sessionEntry: sessionEntry("session-1", "/tmp/session.jsonl", {
            agentHarnessId: "codex",
          }),
        },
      );
      expect(result?.shouldContinue).toBe(false);
      expect(privateReplies).toHaveLength(0);
      expect(execCalls).toHaveLength(available ? 1 : 0);
      if (!available) {
        expect(result?.reply?.text).toContain("Run /diagnostics from an owner DM");
        return;
      }
      expect(result?.reply?.text).toBe(
        "Diagnostics are sensitive. Owner approval is pending on the private route.",
      );
      expect(result?.reply?.text).not.toContain("codex-thread-1");
      const { defaults } = requireExecCall(execCalls);
      expect(defaults).toMatchObject({
        messageProvider: "telegram",
        currentChannelId: "owner-dm",
        accountId: "account-1",
      });
      expect(defaults.approvalWarningText).toContain(
        "Approving diagnostics will also send this thread's feedback bundle",
      );
      expect(defaults.approvalWarningText).not.toContain("To send:");
      expect(calls[0]?.diagnosticsPrivateRouted).toBe(true);
    },
  );

  it("keeps suppressed diagnostics confirmations private", async () => {
    const commandHandler = vi.fn(async () => ({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        "- channel whatsapp, OpenClaw session session-1, Codex thread codex-thread-1",
      ].join("\n"),
    }));
    registerCodexHandler(commandHandler);
    const { privateReplies } = createDiagnosticsHandlerForTest({
      deliveryOutcome: "suppressed",
      privateTargets: [
        { channel: "telegram", to: "owner-dm", accountId: "account-1" },
        { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
      ],
    });

    const result = await runDiagnostics("/diagnostics confirm abc123def456", { isGroup: true });

    expect(result?.reply?.text).toContain(
      "Private delivery of the diagnostics details was suppressed",
    );
    expect(result?.reply?.text).not.toContain("codex-thread-1");
    expect(result?.reply?.text).not.toContain("session-1");
    expect(result?.reply?.text).not.toContain("OpenAI servers");
    expect(privateReplies).toHaveLength(1);
    expect(privateReplies[0]?.targets).toEqual([
      { channel: "telegram", to: "owner-dm", accountId: "account-1" },
    ]);
    expect(privateReplies[0]?.text).toContain("Codex diagnostics sent to OpenAI servers:");
    expect(privateReplies[0]?.text).toContain("codex-thread-1");
  });

  it("keeps an unconfirmed diagnostics reply pending without exposing approval details to the group", async () => {
    const { execCalls, privateReplies } = createDiagnosticsHandlerForTest({
      deliveryOutcome: "pending",
      privateTargets: [{ channel: "telegram", to: "owner-dm" }],
      execResult: {
        content: [{ type: "text", text: "Private failure details at /private/diagnostics.zip" }],
        details: { status: "approval-unavailable", reason: "no-approval-route" },
      },
    });

    const result = await runDiagnostics("/diagnostics", { isGroup: true });

    expect(result?.reply?.text).toContain(
      "Private delivery is pending; I can't confirm receipt yet",
    );
    expect(result?.reply?.text).not.toContain("sent the diagnostics");
    expect(result?.reply?.text).not.toContain("/private/diagnostics.zip");
    expect(result?.reply?.text).not.toContain("openclaw gateway");
    expect(privateReplies).toEqual([
      {
        targets: [{ channel: "telegram", to: "owner-dm" }],
        text: expect.stringContaining("/private/diagnostics.zip"),
      },
    ]);
    expect(execCalls).toHaveLength(1);
  });

  it.each([
    [
      { type: "command", command: "/codex diagnostics confirm abc123def456" },
      { type: "command", command: "/diagnostics confirm abc123def456" },
    ],
    [
      { type: "callback", value: "/codex diagnostics cancel abc123def456" },
      { type: "callback", value: "/diagnostics cancel abc123def456" },
    ],
    [
      { type: "model-picker", version: 1, snapshotToken: "picker-1", intent: "cancel" },
      { type: "model-picker", version: 1, snapshotToken: "picker-1", intent: "cancel" },
    ],
  ] satisfies Array<readonly [MessagePresentationAction, MessagePresentationAction]>)(
    "routes confirmations with %s.type actions without repeating the preamble",
    async (action, expectedAction) => {
      createDiagnosticsHandlerForTest();
      const commandHandler = vi.fn(async (ctx: PluginCommandContext) => ({
        text: `confirmed ${ctx.args}`,
        interactive: interactiveReply(action),
      }));
      registerCodexHandler(commandHandler);

      const result = await runDiagnostics("/diagnostics confirm abc123def456");

      expect(result?.shouldContinue).toBe(false);
      expect(commandHandler).toHaveBeenCalledTimes(1);
      expect(result?.reply?.text).toBe("confirmed diagnostics confirm abc123def456");
      expect(result?.reply?.interactive).toEqual(interactiveReply(expectedAction));
    },
  );

  it("does not delegate diagnostics to a non-Codex plugin command", async () => {
    createDiagnosticsHandlerForTest();
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

    const result = await runDiagnostics("/diagnostics confirm abc123def456");

    expect(result?.reply?.text).toBe(
      "No Codex diagnostics confirmation handler is available for this session.",
    );
    expect(commandHandler).not.toHaveBeenCalled();
  });
});
