import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecToolDefaults } from "../../agents/bash-tools.exec-types.js";
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
import { handleDiagnosticsCommand } from "./commands-diagnostics.js";
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

type ExecCall = {
  defaults: unknown;
  params: unknown;
};

type ExecParams = {
  ask?: string;
  command?: string;
};

type PrivateDiagnosticsReply = {
  targets: Array<{ channel: string; to: string; accountId?: string | null }>;
  text?: string;
};

const privateTargets = [
  { channel: "telegram", to: "owner-dm", accountId: "account-1" },
  { channel: "whatsapp", to: "backup-owner-dm", accountId: "account-2" },
];

function requireExecCall(execCalls: ExecCall[], index = 0) {
  const call = execCalls[index];
  if (!call) {
    throw new Error(`expected exec call #${index + 1}`);
  }
  return {
    defaults: call.defaults as ExecToolDefaults,
    params: call.params as ExecParams,
  };
}

function requireDiagnosticsSessions(call: PluginCommandContext | undefined) {
  const sessions = call?.diagnosticsSessions;
  if (!sessions) {
    throw new Error("expected diagnostics sessions");
  }
  return sessions;
}

function buildDiagnosticsParams(
  commandBodyNormalized: string,
  overrides: Partial<HandleCommandsParams> = {},
): HandleCommandsParams {
  return {
    cfg: { commands: { text: true } },
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      AccountId: "account-1",
      MessageThreadId: "thread-1",
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "user-1",
      channel: "whatsapp",
      channelId: "whatsapp",
      from: "user-1",
      to: "bot",
    },
    sessionKey: "agent:main:whatsapp:direct:user-1",
    workspaceDir: "/tmp",
    isGroup: false,
    ...overrides,
  } as HandleCommandsParams;
}

const runDiagnostics = (body = "/diagnostics", overrides?: Partial<HandleCommandsParams>) =>
  handleDiagnosticsCommand(buildDiagnosticsParams(body, overrides), true);

function registerCodexCommandForTest(handler: PluginCommandHandler) {
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
    ownership: "reserved",
    handler,
  });
  setActivePluginRegistry(pluginRegistry.registry);
}

function createCodexDiagnosticsSessionEntry() {
  return {
    sessionId: "session-1",
    sessionFile: "/tmp/session.jsonl",
    updatedAt: 1,
    agentHarnessId: "codex",
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
      return { text: "Codex diagnostics sent to OpenAI servers:" };
    }
    throw new Error("expected diagnostics preview or approved upload");
  });
  registerCodexCommandForTest(commandHandler);
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
  diagnosticsCommandMocks.createExecTool.mockImplementation((defaults: unknown) => ({
    execute: vi.fn(async (_toolCallId: string, params: unknown) => {
      execCalls.push({ defaults, params });
      return options.execResult ?? { content: [], details: { status: "approval-pending" } };
    }),
  }));
  diagnosticsCommandMocks.resolvePrivateCommandRouteTargets.mockResolvedValue(
    options.privateTargets ?? [],
  );
  diagnosticsCommandMocks.deliverPrivateCommandReply.mockImplementation(
    async ({
      targets,
      reply,
    }: {
      targets: PrivateDiagnosticsReply["targets"];
      reply: { text?: string };
    }) => {
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
  it("falls back to a visible reply when approval cannot be queued", async () => {
    const { execCalls } = createDiagnosticsHandlerForTest({
      execResult: {
        content: [
          {
            type: "text",
            text: "Exec approval is required, but no interactive approval client is currently available.",
          },
        ],
        details: {
          status: "approval-unavailable",
          reason: "no-approval-route",
        },
      },
    });
    const result = await runDiagnostics();

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
      "Diagnostics can include sensitive local logs and host-level runtime metadata.",
    );
    expect(result?.reply?.text).toContain("https://docs.openclaw.ai/gateway/diagnostics");
    expect(result?.reply?.text).toContain("no interactive approval client");
    expect(execCalls).toHaveLength(1);
  });

  it("wraps native Codex feedback in approval on the originating Telegram route", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest();
    const { execCalls } = createDiagnosticsHandlerForTest();
    const params = buildDiagnosticsParams("/diagnostics flaky tool call", {
      sessionEntry: createCodexDiagnosticsSessionEntry(),
    });
    Object.assign(params.ctx, {
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:1",
      CommandSource: "native",
      ApprovalReviewerDeviceId: "device-diagnostics-reviewer",
    });
    Object.assign(params.command, { channel: "telegram", channelId: "telegram", to: "slash:1" });
    const result = await handleDiagnosticsCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toBe("diagnostics flaky tool call");
    expect(calls[0]?.diagnosticsPreviewOnly).toBe(true);
    expect(calls[0]?.senderIsOwner).toBe(true);
    expect(calls[0]?.sessionFile).toBe("agent:main:whatsapp:direct:user-1");
    const diagnosticsSessions = requireDiagnosticsSessions(calls[0]);
    expect(diagnosticsSessions).toHaveLength(1);
    expect(diagnosticsSessions[0]?.agentHarnessId).toBe("codex");
    expect(diagnosticsSessions[0]?.sessionId).toBe("session-1");
    expect(diagnosticsSessions[0]?.sessionFile).toBe("agent:main:whatsapp:direct:user-1");
    expect(diagnosticsSessions[0]?.channel).toBe("telegram");
    expect(diagnosticsSessions[0]?.accountId).toBe("account-1");
    expect(execCalls).toHaveLength(1);
    const { defaults, params: execParams } = requireExecCall(execCalls);
    expect(defaults.messageProvider).toBe("telegram");
    expect(defaults.currentChannelId).toBe("telegram:1");
    expect(defaults.accountId).toBe("account-1");
    expect(defaults.host).toBe("gateway");
    expect(defaults.security).toBe("allowlist");
    expect(defaults.ask).toBe("always");
    expect(defaults.trigger).toBe("diagnostics");
    expect(defaults.approvalReviewerDeviceId).toBe("device-diagnostics-reviewer");
    expect(defaults.approvalFollowupMode).toBe("direct");
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

  it("loads diagnostics inventory after authorization when the reply view contains one row", async () => {
    await withOpenClawTestState({ label: "diagnostics-session-inventory" }, async (state) => {
      const storePath = path.join(state.sessionsDir("main"), "sessions.json");
      const sessionKey = "agent:main:whatsapp:direct:user-1";
      const otherKey = "agent:main:discord:channel:123";
      const current = {
        sessionId: "active-session",
        sessionFile: "/tmp/active.jsonl",
        updatedAt: Date.now(),
      };
      await upsertSessionEntryCore({ agentId: "main", sessionKey, storePath }, current);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: otherKey, storePath },
        {
          sessionId: "other-session",
          sessionFile: "/tmp/other.jsonl",
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
        expect(requireDiagnosticsSessions(calls[0])).toEqual([
          expect.objectContaining({
            sessionKey,
            sessionFile: sessionKey,
            sessionId: "active-session",
            channel: "whatsapp",
          }),
          expect.objectContaining({
            sessionKey: otherKey,
            sessionFile: otherKey,
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
    registerCodexCommandForTest(
      vi.fn(async () => ({
        text: [
          "No Codex thread is attached to this OpenClaw session yet.",
          "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
        ].join("\n"),
      })),
    );
    const { execCalls } = createDiagnosticsHandlerForTest();

    await runDiagnostics("/diagnostics", {
      sessionEntry: {
        sessionId: "ordinary-session",
        sessionFile: "/tmp/ordinary.jsonl",
        updatedAt: 1,
      },
    });

    expect(requireExecCall(execCalls).defaults.approvalWarningText).not.toContain(
      "OpenAI Codex harness:",
    );
  });

  it("reports private owner approval as pending before starting collection", async () => {
    const { calls } = registerCodexDiagnosticsCommandForTest();
    const { execCalls, privateReplies } = createDiagnosticsHandlerForTest({
      privateTargets,
    });

    const result = await runDiagnostics("/diagnostics flaky tool call", {
      isGroup: true,
      sessionEntry: createCodexDiagnosticsSessionEntry(),
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(
      "Diagnostics are sensitive. Owner approval is pending on the private route.",
    );
    expect(result?.reply?.text).not.toContain("codex-thread-1");
    expect(privateReplies).toHaveLength(0);
    expect(execCalls).toHaveLength(1);
    const { defaults } = requireExecCall(execCalls);
    expect(defaults.messageProvider).toBe("telegram");
    expect(defaults.currentChannelId).toBe("owner-dm");
    expect(defaults.accountId).toBe("account-1");
    expect(defaults.approvalWarningText).toContain(
      "Approving diagnostics will also send this thread's feedback bundle",
    );
    expect(defaults.approvalWarningText).not.toContain("To send:");
    expect(calls[0]?.diagnosticsPrivateRouted).toBe(true);
  });

  it("fails closed in groups when no private diagnostics route is available", async () => {
    registerCodexDiagnosticsCommandForTest();
    const { execCalls, privateReplies } = createDiagnosticsHandlerForTest();

    const result = await runDiagnostics("/diagnostics", {
      isGroup: true,
      sessionEntry: createCodexDiagnosticsSessionEntry(),
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Run /diagnostics from an owner DM");
    expect(execCalls).toHaveLength(0);
    expect(privateReplies).toHaveLength(0);
  });

  it.each([
    {
      outcome: "suppressed" as const,
      body: "/diagnostics confirm abc123def456",
      text: "Codex diagnostics sent to OpenAI servers:\n- channel whatsapp, OpenClaw session session-1, Codex thread codex-thread-1",
      acknowledgement: "Private delivery of the diagnostics details was suppressed",
      excluded: ["codex-thread-1", "session-1", "OpenAI servers"],
      targets: privateTargets,
    },
    {
      outcome: "pending" as const,
      body: "/diagnostics",
      text: "Private failure details at /private/diagnostics.zip",
      acknowledgement: "Private delivery is pending; I can't confirm receipt yet",
      excluded: ["sent the diagnostics", "/private/diagnostics.zip", "openclaw gateway"],
      targets: [{ channel: "telegram", to: "owner-dm" }],
    },
  ])("keeps $outcome diagnostics details private", async (testCase) => {
    if (testCase.outcome === "suppressed") {
      registerCodexCommandForTest(async () => ({ text: testCase.text }));
    }
    const { execCalls, privateReplies } = createDiagnosticsHandlerForTest({
      deliveryOutcome: testCase.outcome,
      privateTargets: testCase.targets,
      execResult: {
        content: [{ type: "text", text: testCase.text }],
        details: { status: "approval-unavailable", reason: "no-approval-route" },
      },
    });
    const result = await runDiagnostics(testCase.body, { isGroup: true });
    expect(result?.reply?.text).toContain(testCase.acknowledgement);
    for (const excluded of testCase.excluded) {
      expect(result?.reply?.text).not.toContain(excluded);
    }
    expect(privateReplies).toEqual([
      { targets: [testCase.targets[0]], text: expect.stringContaining(testCase.text) },
    ]);
    if (testCase.outcome === "pending") {
      expect(execCalls).toHaveLength(1);
    }
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
      {
        type: "model-picker",
        version: 1,
        snapshotToken: "picker-1",
        intent: "cancel",
      },
    ],
  ] satisfies Array<readonly [MessagePresentationAction, MessagePresentationAction]>)(
    "routes confirmations with %s.type actions without repeating the preamble",
    async (action, expectedAction) => {
      createDiagnosticsHandlerForTest();
      const interactive: LegacyInteractiveReply = {
        blocks: [{ type: "buttons", buttons: [{ label: "Continue", action }] }],
      };
      const expectedInteractive: LegacyInteractiveReply = {
        blocks: [{ type: "buttons", buttons: [{ label: "Continue", action: expectedAction }] }],
      };
      interactive.blocks.push({ type: "select", options: [{ label: "Continue", action }] });
      expectedInteractive.blocks.push({
        type: "select",
        options: [{ label: "Continue", action: expectedAction }],
      });
      const commandHandler = vi.fn(async (ctx: PluginCommandContext) => ({
        text: `confirmed ${ctx.args}`,
        interactive,
      }));
      registerCodexCommandForTest(commandHandler);

      const result = await runDiagnostics("/diagnostics confirm abc123def456");

      expect(result?.shouldContinue).toBe(false);
      expect(commandHandler).toHaveBeenCalledTimes(1);
      expect(result?.reply?.text).toBe("confirmed diagnostics confirm abc123def456");
      expect(result?.reply?.interactive).toEqual(expectedInteractive);
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
