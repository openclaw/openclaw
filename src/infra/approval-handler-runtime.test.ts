import { describe, expect, it, vi } from "vitest";
import {
  createChannelApprovalHandlerFromCapability,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-runtime.js";

describe("createChannelApprovalHandlerFromCapability", () => {
  it("returns null when the capability does not expose a native runtime", async () => {
    await expect(
      createChannelApprovalHandlerFromCapability({
        capability: {},
        label: "test/approval-handler",
        clientDisplayName: "Test Approval Handler",
        channel: "test",
        channelLabel: "Test",
        cfg: {} as never,
      }),
    ).resolves.toBeNull();
  });

  it("returns a runtime when the capability exposes a native runtime", async () => {
    const runtime = await createChannelApprovalHandlerFromCapability({
      capability: {
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
      label: "test/approval-handler",
      clientDisplayName: "Test Approval Handler",
      channel: "test",
      channelLabel: "Test",
      cfg: { channels: {} } as never,
    });

    expect(runtime).not.toBeNull();
  });

  it("preserves the original request and resolved approval kind when stop-time cleanup unbinds", async () => {
    const unbindPending = vi.fn();
    const runtime = await createChannelApprovalHandlerFromCapability({
      capability: {
        native: {
          describeDeliveryCapabilities: vi.fn().mockReturnValue({
            enabled: true,
            preferredSurface: "origin",
            supportsOriginSurface: true,
            supportsApproverDmSurface: false,
            notifyOriginWhenDmOnly: false,
          }),
          resolveOriginTarget: vi.fn().mockReturnValue({ to: "origin-chat" }),
        },
        nativeRuntime: {
          resolveApprovalKind: vi.fn().mockReturnValue("plugin"),
          availability: {
            isConfigured: vi.fn().mockReturnValue(true),
            shouldHandle: vi.fn().mockReturnValue(true),
          },
          presentation: {
            buildPendingPayload: vi.fn().mockResolvedValue({ text: "pending" }),
            buildResolvedResult: vi.fn(),
            buildExpiredResult: vi.fn(),
          },
          transport: {
            prepareTarget: vi.fn().mockResolvedValue({
              dedupeKey: "origin-chat",
              target: { to: "origin-chat" },
            }),
            deliverPending: vi.fn().mockResolvedValue({ messageId: "1" }),
          },
          interactions: {
            bindPending: vi.fn().mockResolvedValue({ bindingId: "bound" }),
            unbindPending,
          },
        },
      },
      label: "test/approval-handler",
      clientDisplayName: "Test Approval Handler",
      channel: "test",
      channelLabel: "Test",
      cfg: { channels: {} } as never,
    });

    expect(runtime).not.toBeNull();
    const request = {
      id: "custom:1",
      expiresAtMs: Date.now() + 60_000,
      request: {
        turnSourceChannel: "test",
        turnSourceTo: "origin-chat",
      },
    } as never;

    await runtime?.handleRequested(request);
    await runtime?.stop();

    expect(unbindPending).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        approvalKind: "plugin",
      }),
    );
  });
});

describe("createLazyChannelApprovalNativeRuntimeAdapter", () => {
  it("loads the runtime lazily and reuses the loaded adapter", async () => {
    const explicitIsConfigured = vi.fn().mockReturnValue(true);
    const explicitShouldHandle = vi.fn().mockReturnValue(false);
    const buildPendingPayload = vi.fn().mockResolvedValue({ text: "pending" });
    const load = vi.fn().mockResolvedValue({
      availability: {
        isConfigured: vi.fn(),
        shouldHandle: vi.fn(),
      },
      presentation: {
        buildPendingPayload,
        buildResolvedResult: vi.fn(),
        buildExpiredResult: vi.fn(),
      },
      transport: {
        prepareTarget: vi.fn(),
        deliverPending: vi.fn(),
      },
    });
    const adapter = createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec"],
      isConfigured: explicitIsConfigured,
      shouldHandle: explicitShouldHandle,
      load,
    });
    const cfg = { channels: {} } as never;
    const request = { id: "exec:1" } as never;
    const view = {} as never;

    expect(adapter.eventKinds).toEqual(["exec"]);
    expect(adapter.availability.isConfigured({ cfg })).toBe(true);
    expect(adapter.availability.shouldHandle({ cfg, request })).toBe(false);
    await expect(
      adapter.presentation.buildPendingPayload({
        cfg,
        request,
        approvalKind: "exec",
        nowMs: 1,
        view,
      }),
    ).resolves.toEqual({ text: "pending" });
    expect(load).toHaveBeenCalledTimes(1);
    expect(explicitIsConfigured).toHaveBeenCalledWith({ cfg });
    expect(explicitShouldHandle).toHaveBeenCalledWith({ cfg, request });
    expect(buildPendingPayload).toHaveBeenCalledWith({
      cfg,
      request,
      approvalKind: "exec",
      nowMs: 1,
      view,
    });
  });
});
