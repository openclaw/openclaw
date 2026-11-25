import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinel } from "../../infra/restart-sentinel-store.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { scheduleGatewayRestart } from "../../infra/restart.js";
import { buildSessionCommandTestParams } from "./commands-session-params.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

type ScheduleGatewayRestartArgs = Parameters<typeof scheduleGatewayRestart>[0];

const mocks = vi.hoisted(() => ({
  clear: vi.fn(async (_revision: number) => true),
  enabled: vi.fn(() => true),
  delivery: vi.fn(() => ({
    deliveryContext: {
      channel: "telegram",
      to: "telegram:123",
      accountId: "default",
    },
    threadId: "thread-1",
  })),
  hint: vi.fn(() => "doctor hint"),
  write: vi.fn(async (payload: RestartSentinelPayload): Promise<RestartSentinel> => ({
    version: 1,
    revision: 1,
    payload,
  })),
  schedule: vi.fn((_opts?: ScheduleGatewayRestartArgs) => ({
    scheduled: true,
  })),
  trigger: vi.fn(() => ({ ok: true, method: "launchctl" })),
}));

// mock-isolation: Exercise both restart policy outcomes using a fixture-owned gate.
vi.mock("../../config/commands.flags.js", () => ({
  isRestartEnabled: mocks.enabled,
}));
// mock-isolation: Delivery metadata comes from the fixture, without reading operator sessions.
vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: mocks.delivery,
}));

vi.mock("../../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../globals.js")>()),
  logVerbose: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: vi.fn(),
  normalizeChannelId: (value?: string | null) => value?.trim().toLowerCase() ?? null,
}));

vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-sentinel.js")>()),
  clearRestartSentinelIfRevision: mocks.clear,
  formatDoctorNonInteractiveHint: mocks.hint,
  writeRestartSentinel: mocks.write,
}));

// mock-isolation: Record restart requests without scheduling or restarting a real Gateway.
vi.mock("../../infra/restart.js", () => ({
  scheduleGatewayRestart: mocks.schedule,
  triggerOpenClawRestart: mocks.trigger,
}));

const { handleRestartCommand } = await import("./commands-session.js");

function restartParams(overrides?: Partial<HandleCommandsParams>): HandleCommandsParams {
  const { command, ...rest } = overrides ?? {};
  return buildSessionCommandTestParams(
    command ?? {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "user-1",
      rawBodyNormalized: "/restart",
      commandBodyNormalized: "/restart",
    },
    {
      sessionKey: "agent:main:telegram:direct:123:thread:thread-1",
      ...rest,
    },
  );
}

async function withRestartSignal<T>(run: () => Promise<T>) {
  const handler = () => {};
  process.on("SIGUSR2", handler);
  try {
    return await run();
  } finally {
    process.removeListener("SIGUSR2", handler);
  }
}

function adoptionParams(onAdopted: () => void | Promise<void>) {
  return restartParams({ opts: { turnAdoptionLifecycle: { onAdopted } } });
}

function expectNoRestart() {
  expect(mocks.trigger).not.toHaveBeenCalled();
  expect(mocks.schedule).not.toHaveBeenCalled();
}

describe("handleRestartCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReset().mockReturnValue(true);
    mocks.trigger.mockReset().mockReturnValue({ ok: true, method: "launchctl" });
  });

  it("prepares the routed sentinel only when SIGUSR2 restart emits", async () => {
    await withRestartSignal(async () => {
      const params = restartParams();
      const result = await handleRestartCommand(params, true);
      expect(result?.reply?.text).toContain("SIGUSR2");
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.trigger).not.toHaveBeenCalled();
      const scheduledArgs = mocks.schedule.mock.calls.at(-1)?.[0];
      expect(scheduledArgs).toMatchObject({ sessionKey: params.sessionKey });
      await scheduledArgs?.emitHooks?.beforeEmit?.();
      expect(mocks.write).toHaveBeenCalledOnce();
      expect(mocks.write.mock.calls[0]?.[0]).toMatchObject({
        kind: "restart",
        status: "ok",
        sessionKey: "agent:main:telegram:direct:123:thread:thread-1",
        continuation: null,
      });
    });
  });

  it.each([
    ["schedule", mocks.schedule],
    ["fallback", mocks.trigger],
  ] as const)("adopts ingress before %s restart", async (path, restart) => {
    const adopt = vi.fn();
    const run = () => handleRestartCommand(adoptionParams(adopt), true);
    await (path === "schedule" ? withRestartSignal(run) : run());
    // An unadopted claim would be replayed by the successor, restarting forever.
    expect(adopt).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(adopt.mock.invocationCallOrder[0]).toBeLessThan(restart.mock.invocationCallOrder[0]!);
  });

  it("does not restart when ingress adoption was lost to another owner", async () => {
    await expect(
      handleRestartCommand(
        adoptionParams(() => {
          throw new Error("ingress adoption lost: guillotined");
        }),
        true,
      ),
    ).rejects.toThrow("ingress adoption lost");
    expectNoRestart();
  });

  it("gives authorized non-owner text restart commands the owner setup hint", async () => {
    const result = await handleRestartCommand(
      restartParams({
        ctx: { CommandSource: "text" },
        command: {
          ...restartParams().command,
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
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("does not restart when the sentinel cannot be written", async () => {
    mocks.write.mockRejectedValueOnce(new Error("disk full"));
    const result = await handleRestartCommand(restartParams(), true);
    expect(result?.reply?.text).toContain("could not persist");
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  it("clears the success sentinel when fallback restart fails", async () => {
    mocks.trigger.mockReturnValueOnce({ ok: false, method: "launchctl" });
    const result = await handleRestartCommand(restartParams(), true);
    expect(result?.reply?.text).toContain("Restart failed");
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(1);
  });
});
