import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readRestartSentinel, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import {
  resetGatewayRestartStateForInProcessRestart,
  setPreRestartDeferralCheck,
} from "../../infra/restart.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { restartHandlers } from "./restart.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

let config: OpenClawConfig;
const emitted = vi.fn();
async function restart(params: Record<string, unknown>, guard?: () => void) {
  let result: unknown;
  await restartHandlers["gateway.restart.request"]!({
    params,
    context: { getRuntimeConfig: () => config },
    sessionMutationCommitGuard: guard,
    respond: (ok, value, error) => {
      if (!ok) {
        throw new Error(error?.message);
      }
      result = value;
    },
  } as GatewayRequestHandlerOptions);
  return result;
}

beforeAll(async () => {
  // A running Gateway already has shared state before owner authorization reads it.
  await writeRestartSentinel({ kind: "restart", status: "ok", ts: 1 });
});

beforeEach(() => {
  config = { commands: { ownerAllowFrom: ["owner"] } };
  vi.useFakeTimers();
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  emitted.mockClear();
  process.on("SIGUSR2", emitted);
});
afterEach(() => {
  process.off("SIGUSR2", emitted);
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
  setPreRestartDeferralCheck(() => 0);
  vi.useRealTimers();
});

it.each([
  ["non-owner", "other", "current owner principal"],
  ["disabled", "owner", "commands.restart=false"],
  ["requester-revoked", "owner", "requester revoked"],
])("refuses %s without restarting", async (change, senderId, error) => {
  if (change === "disabled") {
    config.commands!.restart = false;
  }
  await expect(
    restart(
      { requester: { channel: "slack", senderId } },
      change === "requester-revoked"
        ? () => {
            throw new Error("requester revoked");
          }
        : undefined,
    ),
  ).rejects.toThrow(error);
  await vi.advanceTimersByTimeAsync(0);
  expect(emitted).not.toHaveBeenCalled();
});

it.each(["owner", "restart-policy"])(
  "cancels deferred restart when %s authority changes",
  async (change) => {
    let activeWork = 1;
    setPreRestartDeferralCheck(() => activeWork);
    expect(await restart({ requester: { channel: "slack", senderId: "owner" } })).toMatchObject({
      ok: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    config = {
      commands: {
        ownerAllowFrom: change === "owner" ? [] : ["owner"],
        restart: change !== "restart-policy",
      },
    };
    activeWork = 0;
    await vi.advanceTimersByTimeAsync(500);
    expect(emitted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("persists the requesting session's completion notice before the runtime restart", async () => {
  setPreRestartDeferralCheck(() => 0);
  const done = createDeferredCore();
  process.once("SIGUSR2", () => done.resolve());
  const sessionKey = "agent:main:restart-notice";
  expect(
    await restart({
      reason: "gateway.restart.agent",
      sessionKey,
      deliveryContext: { channel: "webchat" },
      note: "Requested maintenance restart",
    }),
  ).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(0);
  await done.promise;
  expect((await readRestartSentinel())?.payload).toMatchObject({
    kind: "restart",
    sessionKey,
    message: "Requested maintenance restart",
    stats: { mode: "gateway.restart", reason: "gateway.restart.agent" },
  });
  expect(emitted).toHaveBeenCalledOnce();
});
