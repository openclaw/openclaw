import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import { startChannelApprovalHandlerBootstrap } from "./approval-handler-bootstrap.js";

const { createChannelApprovalHandlerFromCapability } = vi.hoisted(() => ({
  createChannelApprovalHandlerFromCapability: vi.fn(),
}));

vi.mock("./approval-handler-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./approval-handler-runtime.js")>(
    "./approval-handler-runtime.js",
  );
  return {
    ...actual,
    createChannelApprovalHandlerFromCapability,
  };
});

describe("startChannelApprovalHandlerBootstrap", () => {
  beforeEach(() => {
    createChannelApprovalHandlerFromCapability.mockReset();
  });

  const flushTransitions = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  it("starts and stops the shared approval handler from runtime context registration", async () => {
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({
      start,
      stop,
    });

    const cleanup = await startChannelApprovalHandlerBootstrap({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        approvalCapability: {
          nativeRuntime: {
            availability: {
              isConfigured: vi.fn().mockReturnValue(true),
              shouldHandle: vi.fn().mockReturnValue(true),
            },
            presentation: {
              buildPendingPayload: vi.fn(),
              buildResolvedResult: vi.fn(),
              buildExpiredResult: vi.fn(),
            },
            transport: {
              prepareTarget: vi.fn(),
              deliverPending: vi.fn(),
            },
          },
        },
      } as never,
      cfg: {} as never,
      accountId: "default",
      channelRuntime,
    });

    const lease = channelRuntime.runtimeContexts.register({
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      context: { app: { ok: true } },
    });
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);

    lease.dispose();
    await flushTransitions();

    expect(stop).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("starts immediately when the runtime context was already registered", async () => {
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({
      start,
      stop,
    });

    const lease = channelRuntime.runtimeContexts.register({
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      context: { app: { ok: true } },
    });

    const cleanup = await startChannelApprovalHandlerBootstrap({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        approvalCapability: {
          nativeRuntime: {
            availability: {
              isConfigured: vi.fn().mockReturnValue(true),
              shouldHandle: vi.fn().mockReturnValue(true),
            },
            presentation: {
              buildPendingPayload: vi.fn(),
              buildResolvedResult: vi.fn(),
              buildExpiredResult: vi.fn(),
            },
            transport: {
              prepareTarget: vi.fn(),
              deliverPending: vi.fn(),
            },
          },
        },
      } as never,
      cfg: {} as never,
      accountId: "default",
      channelRuntime,
    });

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
    lease.dispose();
  });

  it("does not start a handler after the runtime context is unregistered mid-boot", async () => {
    const channelRuntime = createRuntimeChannel();
    let resolveRuntime:
      | ((value: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const runtimePromise = new Promise<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });
    createChannelApprovalHandlerFromCapability.mockReturnValue(runtimePromise);

    const cleanup = await startChannelApprovalHandlerBootstrap({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        approvalCapability: {
          nativeRuntime: {
            availability: {
              isConfigured: vi.fn().mockReturnValue(true),
              shouldHandle: vi.fn().mockReturnValue(true),
            },
            presentation: {
              buildPendingPayload: vi.fn(),
              buildResolvedResult: vi.fn(),
              buildExpiredResult: vi.fn(),
            },
            transport: {
              prepareTarget: vi.fn(),
              deliverPending: vi.fn(),
            },
          },
        },
      } as never,
      cfg: {} as never,
      accountId: "default",
      channelRuntime,
    });

    const lease = channelRuntime.runtimeContexts.register({
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      context: { app: { ok: true } },
    });
    await flushTransitions();

    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);

    lease.dispose();
    resolveRuntime?.({ start, stop });
    await flushTransitions();

    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    await cleanup();
  });
});
