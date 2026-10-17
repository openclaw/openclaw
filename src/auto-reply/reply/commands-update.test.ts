import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { handleUpdateCommand } from "./commands-update.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const { dispatch, callGatewayTool, readChannelContextGatewayContextResolver, host } = vi.hoisted(
  () => ({
    dispatch: vi.fn(),
    callGatewayTool: vi.fn(),
    readChannelContextGatewayContextResolver: vi.fn(),
    host: { context: {} as GatewayRequestContext | undefined },
  }),
);
vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool }));
vi.mock("../../channels/message-access/admission-evidence.js", () => ({
  readChannelContextGatewayContextResolver,
}));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  dispatchGatewayMethodInProcess: dispatch,
  getInProcessGatewayRequestContext: (resolve?: () => GatewayRequestContext | undefined) =>
    resolve ? resolve() : host.context,
}));
vi.mock("../../globals.js", () => ({ logVerbose: vi.fn() }));

const runId = "6631ecee-adbf-41e8-a0e3-1b88b28b0a59";
function updateRun(patch: Partial<UpdateRunRecord> = {}): UpdateRunRecord {
  return {
    runId,
    createdAtMs: 1,
    updatedAtMs: 1,
    trigger: "chat",
    phase: "requested",
    status: "running",
    reason: null,
    origin: {},
    target: {},
    before: {},
    after: {},
    steps: [],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
    ...patch,
  };
}

function updateCommandParams(): HandleCommandsParams {
  return {
    ctx: {},
    cfg: {},
    agentId: "main",
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "owner",
      rawBodyNormalized: "/update",
      commandBodyNormalized: "/update",
    },
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:telegram:direct:owner:thread:topic",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.6-luna",
    contextTokens: 0,
    isGroup: false,
  };
}

function startedHandoff(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    runId,
    result: { status: "skipped", reason: "managed-service-handoff-started", steps: [] },
    handoff: { status: "started", command: "openclaw update" },
    ...overrides,
  };
}

describe("handleUpdateCommand", () => {
  let params: HandleCommandsParams;
  const run = () => handleUpdateCommand(params, true);
  async function expectStopped(text?: string) {
    expect(await run()).toEqual({
      shouldContinue: false,
      ...(text === undefined ? {} : { reply: { text } }),
    });
  }
  beforeEach(() => {
    params = updateCommandParams();
    dispatch.mockReset().mockResolvedValue({ run: updateRun() });
    callGatewayTool.mockReset();
    readChannelContextGatewayContextResolver.mockReset();
    host.context = {} as GatewayRequestContext;
  });

  it.each([
    { body: "/update", allowTextCommands: false },
    { body: "/updated", allowTextCommands: true },
  ])("ignores $body when text commands are $allowTextCommands", async (testCase) => {
    params.command.commandBodyNormalized = testCase.body;

    expect(await handleUpdateCommand(params, testCase.allowTextCommands)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("silently rejects unauthorized senders even when owner", async () => {
    params.command.isAuthorizedSender = false;

    await expectStopped();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns an owner setup hint for an authorized text sender", async () => {
    params.ctx.CommandSource = "text";
    params.command.senderIsOwner = false;
    params.command.senderId = "123456789";

    await expectStopped(
      "You are not authorized to use this owner-only command. Ask the operator to run `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'` in a terminal to make this sender a command owner.",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("honors commands.restart=false without starting an update", async () => {
    params.cfg.commands = { restart: false };

    await expectStopped("⚠️ /update is disabled (commands.restart=false).");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("hands off an owner update with session routing and only a request watchdog", async () => {
    const order: string[] = [];
    const onAdopted = vi.fn(async () => {
      await Promise.resolve();
      order.push("adopt");
    });
    const channelGateway = {} as GatewayRequestContext;
    const channelResolver = () => channelGateway;
    readChannelContextGatewayContextResolver.mockReturnValue(channelResolver);
    params.opts = { turnAdoptionLifecycle: { onAdopted } };
    dispatch.mockImplementationOnce(async () => {
      order.push("update");
      return startedHandoff({ ackDelivered: true });
    });

    await expectStopped();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "update.run",
      {
        sessionKey: params.sessionKey,
        note: "/update",
        requester: { channel: "telegram", senderId: "owner", accountId: undefined },
      },
      {
        timeoutMs: 1_200_000,
        resolveGatewayContext: expect.any(Function),
        forceSyntheticClient: true,
        operatorRoleActor: { kind: "system" },
        syntheticScopes: ["operator.admin"],
        syntheticScopeMode: "minimum",
      },
    );
    expect(order).toEqual(["adopt", "update"]);
    expect(readChannelContextGatewayContextResolver).toHaveBeenCalledWith(params.ctx);
    expect(dispatch.mock.calls[0]?.[2].resolveGatewayContext()).toBe(channelGateway);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("does not update when ingress adoption was lost to another owner", async () => {
    params.opts = {
      turnAdoptionLifecycle: {
        onAdopted: async () => {
          throw new Error("ingress adoption lost: guillotined");
        },
      },
    };

    await expect(run()).rejects.toThrow("ingress adoption lost");
    expect(dispatch).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("acknowledges an accepted OCM webchat update without waiting for readback", async () => {
    params.command.surface = "webchat";
    params.command.channel = "webchat";
    params.ctx.Provider = "webchat";
    const message =
      "OCM owns this update. Use the Update status view to follow its progress and result.";
    dispatch.mockResolvedValueOnce(
      startedHandoff({
        runId: `ocm:${runId}`,
        result: { status: "skipped", reason: null },
        handoff: { status: "started" },
        message,
      }),
    );

    await expectStopped(
      "⬆️ OpenClaw is updating.\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    "preserves queued ack custody without a duplicate reply (%s)",
    async (ackQueued) => {
      const acknowledgement = "⬆️ Updating OpenClaw… You'll get a message here when it's done.";
      dispatch.mockResolvedValueOnce(
        startedHandoff({
          ackDelivered: false,
          ackQueued,
          acknowledgement,
          result: { status: "skipped", reason: "managed-service-handoff-started" },
          handoff: { status: "started" },
        }),
      );
      await expectStopped(ackQueued ? undefined : acknowledgement);
    },
  );

  it("reports skipped with the exact manual command", async () => {
    const command = "openclaw update --channel stable";
    dispatch.mockResolvedValue({
      run: updateRun({
        status: "skipped",
        phase: "finished",
        reason: "managed-service-handoff-unavailable",
      }),
    });
    dispatch.mockResolvedValueOnce({
      ok: false,
      runId,
      result: { status: "skipped", reason: "managed-service-handoff-unavailable", steps: [] },
      handoff: {
        status: "unavailable",
        command,
        message: "Managed handoff unavailable.\nRun the update from a terminal.",
      },
    });

    await expectStopped(
      `ℹ️ OpenClaw wasn't updated.\nOpen Settings → Updates in the Control UI for details. To continue, run \`${command}\` in your terminal.`,
    );
    expect(dispatch.mock.calls[1]?.slice(0, 2)).toEqual(["update.runs.get", { runId }]);
  });

  it("turns a gateway transport error into a visible failure reply", async () => {
    dispatch.mockRejectedValueOnce(new Error("gateway connection refused"));

    await expectStopped(
      "⚠️ Couldn't confirm the update. Open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
    );
  });
});
