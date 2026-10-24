import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareHostedGatewayStop, type HostedGatewayStop } from "../../daemon/hosted-stop.js";
import { getGatewayProcessInstanceId } from "../../gateway/process-instance.js";
import {
  armGatewaySuspendHandoff,
  consumeGatewaySuspendHandoff,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
} from "../../infra/gateway-suspend-coordinator.js";
import { scheduleSafeGatewayRestart } from "../../infra/restart-coordinator.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createGatewayHostLifecycle } from "./host-lifecycle.js";

vi.mock("../../daemon/hosted-stop.js", () => ({ prepareHostedGatewayStop: vi.fn() }));
vi.mock("../../infra/restart-coordinator.js", () => ({ scheduleSafeGatewayRestart: vi.fn() }));

const expectOutcome = (request: Promise<unknown>, outcome: string) =>
  expect(request).resolves.toEqual({ ok: true, value: { outcome } });

describe("Gateway host lifecycle authority", () => {
  let current = true;
  let serving = true;
  const acceptStop = vi.fn();
  const execute = vi.fn<HostedGatewayStop["execute"]>();
  const dispose = vi.fn<HostedGatewayStop["dispose"]>();
  const owners: ReturnType<typeof createGatewayHostLifecycle>[] = [];
  const owner = (commitExternalStop?: () => void) => {
    const host = createGatewayHostLifecycle({
      isCurrent: () => current,
      isServing: () => serving,
      acceptStop,
      commitExternalStop,
      processOwner: { ownsProcessLifecycle: true, supervisor: null },
    });
    owners.push(host);
    return host;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    dispose.mockResolvedValue(undefined);
    current = serving = true;
    execute.mockResolvedValue({ outcome: "accepted" });
    vi.mocked(prepareHostedGatewayStop).mockResolvedValue({ execute, dispose });
    acceptStop.mockImplementation(() => {
      serving = false;
    });
  });
  afterEach(async () => {
    for (const host of owners.splice(0)) {
      await host.retire();
    }
  });

  it("reports an already-running start and a local scheduled restart without native discovery", async () => {
    const host = owner();
    const guard = vi.fn();
    await expectOutcome(host.capability.request("start", guard), "already-running");
    await expectOutcome(host.capability.request("restart", guard), "scheduled");
    expect(prepareHostedGatewayStop).not.toHaveBeenCalled();
    expect(scheduleSafeGatewayRestart).toHaveBeenCalledExactlyOnceWith({
      reason: "gateway.restart.safe",
    });
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("exposes committed external stop only when its live process host supplies it", () => {
    const legacy = owner();
    expect(legacy.capability.externalRestart?.commitStop).toBeUndefined();
    const commit = vi.fn(() => {
      serving = false;
    });
    const commitStop = owner(commit).capability.externalRestart?.commitStop;
    expect(commitStop).toBeTypeOf("function");
    commitStop!();
    expect(commit).toHaveBeenCalledOnce();
    expect(prepareHostedGatewayStop).not.toHaveBeenCalled();
    expect(() => commitStop!()).toThrow("retired or non-serving");
  });

  it.each(["retired", "replaced"])("refuses committed stop from a %s host", async (change) => {
    const commit = vi.fn();
    const host = owner(commit);
    if (change === "retired") {
      await host.retire();
    }
    if (change === "replaced") {
      current = false;
    }
    expect(() => host.capability.externalRestart!.commitStop!()).toThrow("retired or non-serving");
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["retired", "replaced", "closed"])(
    "rejects after awaited preparation when %s",
    async (change) => {
      const host = owner();
      const preparation = createDeferredCore<HostedGatewayStop>();
      vi.mocked(prepareHostedGatewayStop).mockReturnValue(preparation.promise);
      const request = host.capability.request("stop", () => {});
      const retirement = change === "retired" ? host.retire() : undefined;
      if (change === "replaced") {
        current = false;
      }
      if (change === "closed") {
        serving = false;
      }
      preparation.resolve({ execute, dispose });
      await expect(request).resolves.toMatchObject({ ok: false });
      await retirement;
      expect(acceptStop).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it("keeps serving on preparation failure and preserves a concurrent preparation owner", async () => {
    const host = owner();
    const preparation = createDeferredCore<HostedGatewayStop>();
    vi.mocked(prepareHostedGatewayStop).mockReturnValueOnce(preparation.promise);
    const first = host.capability.request("stop", () => {});
    await expect(host.capability.request("stop", () => {})).resolves.toMatchObject({ ok: false });
    expect(prepareHostedGatewayStop).toHaveBeenCalledOnce();
    preparation.reject(new Error("native permission denied"));
    await expect(first).resolves.toEqual({ ok: false, error: "native permission denied" });
    expect(acceptStop).not.toHaveBeenCalled();
    await expect(host.capability.request("start", () => {})).resolves.toMatchObject({ ok: true });
  });

  it("does not carry an armed lease into another host iteration in the same process", async () => {
    const first = owner();
    const processInstanceId = getGatewayProcessInstanceId();
    const lease = prepareGatewaySuspend({
      requestId: "host-iteration-handoff",
      drain: true,
      pauseScheduling: () => {},
      resumeScheduling: () => {},
      inspect: { getRootRequests: () => 1, getTerminalPersistence: () => 0 },
    });
    if (lease.status !== "draining" || !first.capability.externalRestart) {
      throw new Error("missing owned lease");
    }
    try {
      expect(
        armGatewaySuspendHandoff({
          suspensionId: lease.suspensionId,
          owner: first.capability.externalRestart,
        }).ok,
      ).toBe(true);
      await first.retire();
      const next = owner();
      expect(getGatewayProcessInstanceId()).toBe(processInstanceId);
      expect(first.capability.externalRestart.isCurrent()).toBe(false);
      expect(next.capability.externalRestart?.isCurrent()).toBe(true);
      expect(consumeGatewaySuspendHandoff(first.capability.externalRestart)).toEqual({
        ok: true,
        value: false,
      });
      expect(consumeGatewaySuspendHandoff(next.capability.externalRestart)).toEqual({
        ok: true,
        value: false,
      });
    } finally {
      resumeGatewaySuspend(lease.suspensionId);
    }
  });

  it.each(["preparing", "accepted"])(
    "joins %s executor cleanup before retiring the owner",
    async (phase) => {
      const host = owner();
      const closing = createDeferredCore();
      dispose.mockReturnValue(closing.promise);
      const preparation = createDeferredCore<HostedGatewayStop>();
      if (phase === "preparing") {
        vi.mocked(prepareHostedGatewayStop).mockReturnValueOnce(preparation.promise);
      }
      const request = host.capability.request("stop", () => {});
      if (phase === "accepted") {
        await expectOutcome(request, "scheduled");
      }
      const retired = vi.fn();
      const retirement = host.retire().then(retired);
      if (phase === "preparing") {
        preparation.resolve({ execute, dispose });
      }
      await expect(host.capability.request("restart", () => {})).resolves.toMatchObject({
        ok: false,
      });
      expect(retired).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      closing.resolve();
      await retirement;
      await request;
      expect(dispose).toHaveBeenCalledOnce();
      await expect(host.finishStop()).resolves.toEqual({ outcome: "retired" });
    },
  );

  it("joins an in-flight native inspection on retirement and discards its late result", async () => {
    const host = owner();
    const native = createDeferredCore<{ outcome: "accepted" }>();
    execute.mockReturnValueOnce(native.promise);
    await host.capability.request("stop", () => {});
    const finishing = host.finishStop();
    const retired = vi.fn();
    const retirement = host.retire().then(retired);
    try {
      await nextTurn();
      expect(retired).not.toHaveBeenCalled();
      current = false;
    } finally {
      native.resolve({ outcome: "accepted" });
    }
    await expect(finishing).resolves.toEqual({ outcome: "retired" });
    await retirement;
  });
});
