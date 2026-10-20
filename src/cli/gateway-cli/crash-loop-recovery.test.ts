import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import type {
  inspectGatewayCrashLoopBreakerAsync,
  recordGatewayCrashLoopRecovery,
} from "../../infra/gateway-boot-lifecycle.js";
import { createGatewayCrashLoopRecovery } from "./crash-loop-recovery.js";

const lifecycle = vi.hoisted(() => ({
  inspect: vi.fn<typeof inspectGatewayCrashLoopBreakerAsync>(),
  record: vi.fn<typeof recordGatewayCrashLoopRecovery>(),
}));

// mock-isolation: The adapter owns boot identity; the persistence owner has its own worker tests.
vi.mock("../../infra/gateway-boot-lifecycle.js", () => ({
  inspectGatewayCrashLoopBreakerAsync: lifecycle.inspect,
  recordGatewayCrashLoopRecovery: lifecycle.record,
}));

const cleared = {
  tripped: false,
  recoveryPausedUntilMs: undefined,
  uncleanBoots: 0,
  windowMs: 300_000,
  shouldWriteStabilityBundle: false,
  recovered: true,
};

let activeBootId: string;
let recover: ReturnType<typeof createGatewayCrashLoopRecovery>;
const onRecovered = vi.fn((bootId: string) => {
  activeBootId = bootId;
});

describe("Gateway crash-loop recovery adapter", () => {
  beforeEach(() => {
    activeBootId = "boot-id";
    onRecovered.mockClear();
    recover = createGatewayCrashLoopRecovery({
      bootId: activeBootId,
      getActiveBootId: () => activeBootId,
      onRecovered,
    });
    lifecycle.inspect.mockReset().mockResolvedValue(cleared);
    lifecycle.record.mockReset().mockResolvedValue("recovered-boot-id");
  });

  it("recovers channel autostart only after the full breaker window drains", async () => {
    const deadline = Date.now() + 10_000;
    lifecycle.inspect.mockResolvedValueOnce({
      ...cleared,
      uncleanBoots: 1,
      recoveryPausedUntilMs: deadline,
    });

    await expect(recover()).resolves.toBe(deadline);
    expect(lifecycle.record).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();

    await expect(recover()).resolves.toBeUndefined();
    expect(lifecycle.record.mock.calls[0]?.[0]).toBe("boot-id");
    expect(onRecovered).toHaveBeenCalledExactlyOnceWith("recovered-boot-id");
    await expect(recover()).rejects.toThrow("replaced boot");
    expect(lifecycle.inspect).toHaveBeenCalledTimes(2);
    expect(lifecycle.record).toHaveBeenCalledOnce();
  });

  it.each([
    { phase: "inspection", close: false },
    { phase: "recording", close: false },
    { phase: "inspection", close: true },
  ])("invalidates suspended $phase recovery (close=$close)", async ({ phase, close }) => {
    const controller = new AbortController();
    const pending = createDeferred();
    const entered = createDeferred();
    const closed = new Error("Gateway close prelude");
    const pause = async <T>(result: T) => {
      entered.resolve();
      await pending.promise;
      return result;
    };
    if (phase === "inspection") {
      lifecycle.inspect.mockImplementationOnce(async (_env, _now, signal) => {
        if (!close) {
          return pause(cleared);
        }
        if (!signal) {
          throw new Error("Breaker inspection requires its lifecycle signal");
        }
        entered.resolve();
        await waitForAbortSignal(signal);
        return cleared;
      });
    } else {
      lifecycle.record.mockImplementationOnce(() => pause("old-recovered-boot"));
    }
    const recovery = recover(controller.signal);
    await awaitGateBeforeSettlement(
      entered.promise,
      recovery,
      `Recovery settled before the ${phase} boundary`,
    );
    if (close) {
      const rejected = expect(recovery).rejects.toBe(closed);
      controller.abort(closed);
      await rejected;
      await expect(recover(controller.signal)).rejects.toBe(closed);
      expect(lifecycle.inspect).toHaveBeenCalledOnce();
    } else {
      activeBootId = "next-boot-id";
      pending.resolve();
      await expect(recovery).rejects.toThrow("replaced boot");
    }
    expect(lifecycle.record).toHaveBeenCalledTimes(phase === "inspection" ? 0 : 1);
    if (phase === "recording") {
      expect(lifecycle.record.mock.calls[0]?.[3]).toThrow("replaced boot");
      controller.abort(closed);
      expect(lifecycle.record.mock.calls[0]?.[3]).toThrow(closed);
    }
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it("adopts the committed boot identity when close overtakes its reply", async () => {
    const controller = new AbortController();
    lifecycle.record.mockImplementationOnce(async (_bootId, _env, _now, assertCurrent) => {
      assertCurrent?.();
      controller.abort(new Error("Gateway close prelude"));
      return "committed-boot-id";
    });

    await expect(recover(controller.signal)).resolves.toBeUndefined();
    expect(onRecovered).toHaveBeenCalledExactlyOnceWith("committed-boot-id");
  });
});
