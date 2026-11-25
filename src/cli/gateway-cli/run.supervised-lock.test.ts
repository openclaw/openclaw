import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner.js";
import * as sleeping from "../../utils/sleep.js";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";
import { testing } from "./run.test-support.js";

const inspectGatewayTlsCertificateMock = vi.hoisted(() =>
  vi.fn<typeof import("../../infra/tls/gateway.js").inspectGatewayTlsCertificate>(async () => ({
    ok: false,
    error: "public certificate missing",
  })),
);

vi.mock("../../infra/tls/gateway.js", () => ({
  inspectGatewayTlsCertificate: inspectGatewayTlsCertificateMock,
}));

type RecoveryParams = Parameters<typeof testing.runGatewayLoopWithSupervisedLockRecovery>[0];

function recover(params: Pick<RecoveryParams, "startLoop"> & Partial<RecoveryParams>) {
  return testing.runGatewayLoopWithSupervisedLockRecovery({
    supervisor: "systemd",
    port: 18789,
    healthHost: "127.0.0.1",
    log: { info: vi.fn(), warn: vi.fn() },
    ...params,
  });
}

function createClock() {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  return {
    now: () => elapsed,
    sleep: vi.spyOn(sleeping, "sleep").mockImplementation(async (ms: number) => {
      elapsed += ms;
    }),
    advanceTo: (deadline: number) => {
      elapsed = deadline;
    },
  };
}

function rejectLoop(error: Error) {
  return vi.fn<() => Promise<void>>().mockRejectedValue(error);
}

describe("supervised gateway lock recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries lifecycle contention without treating a healthy port as ownership", async () => {
    const error = new GatewayLockError(
      "failed to acquire gateway state ownership",
      new GatewayStateOwnerContentionError("/synthetic/state/openclaw.sqlite"),
    );
    const startLoop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce();
    const probeHealth = vi.fn(async () => true);
    createClock();
    await recover({ startLoop, probeHealth });
    expect(startLoop).toHaveBeenCalledTimes(2);
    expect(probeHealth).not.toHaveBeenCalled();
  });

  it("spends one budget across supervised retries and lifecycle acquisition", async () => {
    const clock = createClock();
    const error = new GatewayLockError(
      "ownership held",
      new GatewayStateOwnerContentionError("/state"),
    );
    const budgets: Array<number | undefined> = [];
    const startLoop = vi.fn(async (deadlineMs?: number) => {
      budgets.push(deadlineMs === undefined ? undefined : deadlineMs - clock.now());
      if (budgets.length > 1) {
        clock.advanceTo(deadlineMs ?? clock.now());
      }
      throw error;
    });
    await expect(recover({ startLoop })).rejects.toBe(error);
    expect(budgets).toEqual([300_000, 295_000]);
    expect(clock.now()).toBe(300_000);
  });

  it.each(["launchd", "systemd"] as const)(
    "handles a healthy %s-supervised gateway",
    async (supervisor) => {
      const message =
        supervisor === "launchd"
          ? "gateway already running"
          : "another gateway instance is already listening";
      const startLoop = rejectLoop(new GatewayLockError(message));
      const probeHealth = vi.fn(async () => true);
      const failure = await recover({ startLoop, probeHealth, supervisor }).catch(
        (error: unknown) => error,
      );
      if (supervisor === "systemd") {
        expect(testing.resolveGatewayLockErrorExitCode(failure)).toBe(78);
      } else {
        expect(failure).toBeUndefined();
      }
    },
  );

  it.each(["embedded owner", "SQLITE_IOERR"])(
    "does not retry or probe health for %s",
    async (code) => {
      const error =
        code === "embedded owner"
          ? new GatewayLockError(
              "another embedded OpenClaw state writer is active (pid 123); lock timeout after 5000ms",
            )
          : new GatewayLockError(
              "failed to acquire gateway state ownership",
              Object.assign(new Error("storage unavailable"), { code }),
            );
      const startLoop = rejectLoop(error);
      const probeHealth = vi.fn(async () => true);
      const clock = createClock();
      await expect(recover({ startLoop, probeHealth })).rejects.toBe(error);
      expect(startLoop).toHaveBeenCalledOnce();
      expectCallCount(0, probeHealth, clock.sleep);
      expect(testing.resolveGatewayLockErrorExitCode(error)).toBe(1);
    },
  );

  it("bounds supervised retries when the existing gateway stays unhealthy", async () => {
    const clock = createClock();
    const error = new GatewayLockError("gateway already running");
    const startLoop = rejectLoop(error).mockImplementationOnce(async () => {
      clock.advanceTo(288_000);
      throw error;
    });
    const failure = await recover({
      startLoop,
      probeHealth: vi.fn(async () => false),
    }).catch((cause: unknown) => cause);

    expect(testing.resolveGatewayLockErrorExitCode(failure)).toBe(1);
    expect(startLoop).toHaveBeenCalledTimes(4);
    expect(clock.sleep.mock.calls.slice(0, 3)).toEqual([[5000], [5000], [2000]]);
  });

  it("retries public certificate inspection while TLS material is unavailable", async () => {
    inspectGatewayTlsCertificateMock.mockClear();
    const probeHealth = testing.createConfiguredGatewayHealthProbe({
      gateway: { tls: { enabled: true, autoGenerate: true } },
    });

    await expect(probeHealth({ host: "127.0.0.1", port: 18789 })).resolves.toBe(false);
    await expect(probeHealth({ host: "127.0.0.1", port: 18789 })).resolves.toBe(false);

    expect(inspectGatewayTlsCertificateMock).toHaveBeenCalledTimes(2);
  });

  it("recognizes only the OpenClaw health response", () => {
    const health = (code: number, body: string) => testing.isGatewayHealthzResponse(code, body);
    expect(health(200, '{"ok":true,"status":"live"}')).toBe(true);
    expect(health(200, '{"ok":true,"status":"ready"}')).toBe(false);
    expect(health(404, "not found")).toBe(false);
    expect(health(200, "not json")).toBe(false);
  });
});
