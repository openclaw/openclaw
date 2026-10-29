import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayCronReconciliation } from "./server-cron-reconciled.js";

type RunHook = Parameters<typeof createGatewayCronReconciliation>[0]["runHook"];

describe("gateway cron reconciliation lifecycle", () => {
  let runHook: ReturnType<typeof vi.fn<RunHook>>;
  let closing: boolean;
  let reconciliation: ReturnType<typeof createGatewayCronReconciliation>;
  beforeEach(() => {
    runHook = vi.fn<RunHook>(async () => undefined);
    closing = false;
    reconciliation = createGatewayCronReconciliation({
      port: 18789,
      workspaceDir: "/tmp/openclaw-workspace",
      isClosing: () => closing,
      runHook,
    });
  });
  const arm = (reason: "startup" | "reload", enabled = true) =>
    reconciliation.arm({
      reason,
      config: {},
      cronState: { cron: {}, storePath: "/tmp/cron.json", cronEnabled: enabled } as never,
    });
  it("emits only the public snapshot fields and captures the reconciled service", async () => {
    const cron = { id: "startup-cron" };
    const config = { cron: { enabled: true } } as OpenClawConfig;
    const cronState = {
      cron,
      storePath: "/private/cron.json",
      cronEnabled: false,
    };
    const armed = reconciliation.arm({
      reason: "startup",
      config,
      cronState: cronState as never,
    });
    cronState.cron = { id: "replacement-cron" };
    await armed.complete();
    await armed.complete();

    expect(runHook).toHaveBeenCalledTimes(1);
    const [event, ctx] = runHook.mock.calls[0] ?? [];
    expect(event).toEqual({ reason: "startup", enabled: false });
    expect(ctx).toMatchObject({
      port: 18789,
      workspaceDir: "/tmp/openclaw-workspace",
      config,
      abortSignal: expect.objectContaining({ aborted: false }),
    });
    expect(ctx?.getCron?.()).toBe(cron);
    expect(ctx?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("suppresses a startup completion superseded by reload", async () => {
    const startup = arm("startup");
    const reload = arm("reload");

    await startup.complete();
    await reload.complete();

    expect(runHook).toHaveBeenCalledTimes(1);
    expect(runHook.mock.calls[0]?.[0]).toEqual({ reason: "reload", enabled: true });
  });

  it("suppresses invalidated and shutdown completions", async () => {
    const invalidated = arm("reload");
    reconciliation.invalidate();
    await invalidated.complete();

    const shutdown = arm("reload", false);
    closing = true;
    await shutdown.complete();

    expect(runHook).not.toHaveBeenCalled();
  });

  it.each(["reload", "invalidate"] as const)(
    "aborts an active snapshot on %s without waiting for its hook",
    async (action) => {
      const hookGate = createDeferred();
      let activeSignal: AbortSignal | undefined;
      const order: string[] = [];
      runHook.mockImplementation(async (event, ctx) => {
        order.push(`${event.reason}:start`);
        if (event.reason === "startup") {
          activeSignal = ctx.abortSignal;
          await hookGate.promise;
        }
        order.push(`${event.reason}:end`);
      });
      const completion = arm("startup").complete();
      await vi.waitFor(() => expect(order).toEqual(["startup:start"]));
      if (action === "reload") {
        const reload = arm("reload");
        expect(activeSignal?.aborted).toBe(true);
        await reload.complete();
        expect(order).toEqual(["startup:start", "reload:start", "reload:end"]);
      } else {
        reconciliation.invalidate();
        expect(activeSignal?.aborted).toBe(true);
      }
      hookGate.resolve();
      await completion;
      if (action === "reload") {
        expect(order).toEqual(["startup:start", "reload:start", "reload:end", "startup:end"]);
      }
    },
  );
});
