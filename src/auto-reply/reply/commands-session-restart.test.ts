// Tests session restart command behavior and runtime reset handoff.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinel } from "../../infra/restart-sentinel-store.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { scheduleGatewayRestart } from "../../infra/restart.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { HandleCommandsParams } from "./commands-types.js";

type ScheduleGatewayRestartArgs = Parameters<typeof scheduleGatewayRestart>[0];

const mocks = vi.hoisted(() => ({
  clearRestartSentinelIfRevision: vi.fn(async (_revision: number) => true),
  isRestartEnabled: vi.fn(() => true),
  extractDeliveryInfo: vi.fn(() => ({
    deliveryContext: {
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
    },
    threadId: "thread-1",
  })),
  formatDoctorNonInteractiveHint: vi.fn(
    () =>
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
  ),
  writeRestartSentinel: vi.fn(
    async (payload: RestartSentinelPayload): Promise<RestartSentinel> => ({
      version: 1,
      revision: 1,
      payload,
    }),
  ),
  scheduleGatewayRestart: vi.fn((_opts?: ScheduleGatewayRestartArgs) => ({
    scheduled: true,
  })),
  triggerOpenClawRestart: vi.fn(() => ({ ok: true, method: "launchctl" })),
}));

vi.mock("../../config/commands.flags.js", () => ({
  isRestartEnabled: mocks.isRestartEnabled,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: mocks.extractDeliveryInfo,
}));

vi.mock("../../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../globals.js")>()),
  logVerbose: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(),
  normalizeChannelId: (value?: string | null) => value?.trim().toLowerCase() ?? null,
}));

vi.mock("../../channels/plugins/conversation-bindings.js", () => ({
  setChannelConversationBindingIdleTimeoutBySessionKey: vi.fn(),
  setChannelConversationBindingMaxAgeBySessionKey: vi.fn(),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: vi.fn(),
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    clearRestartSentinelIfRevision: mocks.clearRestartSentinelIfRevision,
    formatDoctorNonInteractiveHint: mocks.formatDoctorNonInteractiveHint,
    writeRestartSentinel: mocks.writeRestartSentinel,
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewayRestart: mocks.scheduleGatewayRestart,
  triggerOpenClawRestart: mocks.triggerOpenClawRestart,
}));

const { handleRestartCommand } = await import("./commands-session.js");

function restartCommandParams(overrides?: Partial<HandleCommandsParams>): HandleCommandsParams {
  return {
    ctx: {},
    cfg: {},
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "user-1",
      rawBodyNormalized: "/restart",
      commandBodyNormalized: "/restart",
      from: "telegram:123",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:telegram:direct:123:thread:thread-1",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
    ...overrides,
  } as HandleCommandsParams;
}

function firstRestartSentinelPayload() {
  return mocks.writeRestartSentinel.mock.calls[0]?.[0];
}

describe("handleRestartCommand", () => {
  beforeEach(() => {
    mocks.isRestartEnabled.mockReset();
    mocks.isRestartEnabled.mockReturnValue(true);
    mocks.clearRestartSentinelIfRevision.mockClear();
    mocks.extractDeliveryInfo.mockClear();
    mocks.formatDoctorNonInteractiveHint.mockClear();
    mocks.writeRestartSentinel.mockClear();
    mocks.scheduleGatewayRestart.mockClear();
    mocks.triggerOpenClawRestart.mockReset();
    mocks.triggerOpenClawRestart.mockReturnValue({ ok: true, method: "launchctl" });
  });

  it("writes a routed restart sentinel before restarting from chat", async () => {
    const result = await handleRestartCommand(restartCommandParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expect(mocks.writeRestartSentinel).toHaveBeenCalledOnce();
    const sentinelPayload = firstRestartSentinelPayload();
    expect(sentinelPayload?.kind).toBe("restart");
    expect(sentinelPayload?.status).toBe("ok");
    expect(typeof sentinelPayload?.ts).toBe("number");
    expect(sentinelPayload?.sessionKey).toBe("agent:main:telegram:direct:123:thread:thread-1");
    expect(sentinelPayload?.deliveryContext).toEqual({
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
    });
    expect(sentinelPayload?.threadId).toBe("thread-1");
    expect(sentinelPayload?.message).toBe("/restart");
    expect(sentinelPayload?.continuation).toBeNull();
    expect(sentinelPayload?.doctorHint).toBe(
      "Recommended follow-up: run openclaw doctor --non-interactive in a terminal or approvals-capable OpenClaw surface.",
    );
    expect(sentinelPayload?.stats).toEqual({
      mode: "gateway.restart",
      reason: "/restart",
    });
    expect(mocks.triggerOpenClawRestart).toHaveBeenCalledTimes(1);
  });

  it("prepares the routed sentinel only when SIGUSR2 restart emits", async () => {
    const handler = () => {};
    process.on("SIGUSR2", handler);
    try {
      const params = restartCommandParams();
      params.command.assertOwnerCurrent = vi.fn();
      const result = await handleRestartCommand(params, true);

      expect(result?.reply?.text).toContain("SIGUSR2");
      expect(mocks.writeRestartSentinel).not.toHaveBeenCalled();
      expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();

      const scheduledArgs = mocks.scheduleGatewayRestart.mock.calls.at(-1)?.[0];
      expect(scheduledArgs?.emitHooks?.assertCurrent).toBe(params.command.assertOwnerCurrent);
      await scheduledArgs?.emitHooks?.beforeEmit?.();

      expect(mocks.writeRestartSentinel).toHaveBeenCalledOnce();
      const sentinelPayload = firstRestartSentinelPayload();
      expect(sentinelPayload?.kind).toBe("restart");
      expect(sentinelPayload?.status).toBe("ok");
      expect(sentinelPayload?.sessionKey).toBe("agent:main:telegram:direct:123:thread:thread-1");
      expect(sentinelPayload?.continuation).toBeNull();
    } finally {
      process.removeListener("SIGUSR2", handler);
    }
  });

  it("threads sessionKey into scheduleGatewayRestart so cross-session coalescing is rejected (#86742)", async () => {
    const handler = () => {};
    process.on("SIGUSR2", handler);
    try {
      await handleRestartCommand(restartCommandParams(), true);
      const scheduledArgs = mocks.scheduleGatewayRestart.mock.calls.at(-1)?.[0];
      expect(scheduledArgs?.sessionKey).toBe("agent:main:telegram:direct:123:thread:thread-1");
    } finally {
      process.removeListener("SIGUSR2", handler);
    }
  });

  it("adopts the durable ingress claim before scheduling the restart", async () => {
    const order: string[] = [];
    mocks.scheduleGatewayRestart.mockImplementationOnce((_opts) => {
      order.push("schedule");
      return { scheduled: true };
    });
    const handler = () => {};
    process.on("SIGUSR2", handler);
    try {
      await handleRestartCommand(
        restartCommandParams({
          opts: {
            turnAdoptionLifecycle: {
              onAdopted: () => {
                order.push("adopt");
              },
            },
          } as HandleCommandsParams["opts"],
        }),
        true,
      );
    } finally {
      process.removeListener("SIGUSR2", handler);
    }

    // Unadopted at restart => drain releases with recordAttempt:false and the
    // successor replays /restart, restarting again forever.
    expect(order).toEqual(["adopt", "schedule"]);
  });

  it("adopts the durable ingress claim before the fallback restart path", async () => {
    const order: string[] = [];
    mocks.triggerOpenClawRestart.mockImplementationOnce(() => {
      order.push("trigger");
      return { ok: true, method: "launchctl" };
    });

    await handleRestartCommand(
      restartCommandParams({
        opts: {
          turnAdoptionLifecycle: {
            onAdopted: () => {
              order.push("adopt");
            },
          },
        } as HandleCommandsParams["opts"],
      }),
      true,
    );

    expect(order).toEqual(["adopt", "trigger"]);
  });

  it("does not restart when ingress adoption was lost to another owner", async () => {
    await expect(
      handleRestartCommand(
        restartCommandParams({
          opts: {
            turnAdoptionLifecycle: {
              onAdopted: () => {
                throw new Error("ingress adoption lost: guillotined");
              },
            },
          } as HandleCommandsParams["opts"],
        }),
        true,
      ),
    ).rejects.toThrow("ingress adoption lost");

    expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();
    expect(mocks.scheduleGatewayRestart).not.toHaveBeenCalled();
  });

  it.each(["adoption", "sentinel"] as const)(
    "rejects revoked owner authority after awaited restart %s preparation",
    async (stage) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let current = true;
      const params = restartCommandParams();
      params.command.assertOwnerCurrent = () => {
        if (!current) {
          throw new Error("Owner authority changed");
        }
      };
      const prepare = async () => {
        entered.resolve();
        await release.promise;
      };
      const handler = () => {};
      if (stage === "adoption") {
        params.opts = { turnAdoptionLifecycle: { onAdopted: prepare } };
        process.on("SIGUSR2", handler);
      } else {
        mocks.writeRestartSentinel.mockImplementationOnce(async (payload) => {
          await prepare();
          return { version: 1, revision: 1, payload };
        });
      }
      const command = handleRestartCommand(params, true);
      try {
        await entered.promise;
        current = false;
        release.resolve();
        expect((await command)?.reply?.text).toContain("owner authority changed");
        expect(mocks.scheduleGatewayRestart).not.toHaveBeenCalled();
        expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();
        expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledTimes(
          stage === "sentinel" ? 1 : 0,
        );
      } finally {
        release.resolve();
        await command;
        process.removeListener("SIGUSR2", handler);
      }
    },
  );

  it.each(["text", "native"] as const)(
    "gives authorized non-owner %s restart commands the owner setup hint",
    async (source) => {
      const result = await handleRestartCommand(
        restartCommandParams({
          ctx: { CommandSource: source },
          command: {
            ...restartCommandParams().command,
            senderIsOwner: false,
            isAuthorizedSender: true,
          },
        }),
        true,
      );

      expect(result).toEqual({
        shouldContinue: false,
        reply: {
          text: "You are not authorized to use this owner-only command. Ask the operator to run `openclaw config set commands.ownerAllowFrom '[\"telegram:user-1\"]'` in a terminal to make this sender a command owner.",
        },
      });
      expect(mocks.writeRestartSentinel).not.toHaveBeenCalled();
      expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();
    },
  );

  it("does not restart when the sentinel cannot be written", async () => {
    mocks.writeRestartSentinel.mockRejectedValueOnce(new Error("disk full"));

    const result = await handleRestartCommand(restartCommandParams(), true);

    expect(result?.reply?.text).toContain("could not persist");
    expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();
  });

  it("clears the success sentinel when fallback restart fails", async () => {
    mocks.triggerOpenClawRestart.mockReturnValueOnce({
      ok: false,
      method: "launchctl",
    });

    const result = await handleRestartCommand(restartCommandParams(), true);

    expect(result?.reply?.text).toContain("Restart failed");
    expect(mocks.clearRestartSentinelIfRevision).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("preserves a newer acknowledgement when owner revocation cancels the prepared restart", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sentinel = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
        "../../infra/restart-sentinel.js",
      );
      const params = restartCommandParams();
      let current = true;
      params.command.assertOwnerCurrent = () => {
        if (!current) {
          throw new Error("Owner authority changed");
        }
      };
      let replacement: RestartSentinel | undefined;
      mocks.writeRestartSentinel.mockImplementationOnce(async (payload) => {
        const prepared = await sentinel.writeRestartSentinel(payload);
        replacement = await sentinel.writeRestartSentinel({
          ...payload,
          message: "newer accepted restart",
        });
        current = false;
        return prepared;
      });
      mocks.clearRestartSentinelIfRevision.mockImplementationOnce(
        sentinel.clearRestartSentinelIfRevision,
      );

      const result = await handleRestartCommand(params, true);

      expect(result?.reply?.text).toContain("owner authority changed");
      expect(mocks.triggerOpenClawRestart).not.toHaveBeenCalled();
      expect(replacement).toBeDefined();
      expect(await sentinel.readRestartSentinel()).toEqual(replacement);
    });
  });
});
