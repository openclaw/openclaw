import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { ChannelWizardHost } from "./wizard-host.ts";

describe("channel wizard completion", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["current", "reload"],
    ["closed", "reload"],
    ["disconnected", "reload"],
    ["replaced", "reload"],
    ["context changed", "reload"],
    ["closed", "refresh"],
  ])("keeps the WhatsApp handoff with its %s owner after %s", async (outcome, boundary) => {
    vi.useFakeTimers();
    const operationStarted = createDeferred();
    const operation = createDeferred();
    const { gateway } = createApplicationGateway();
    let starts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "wizard.cancel") {
        return { done: true, status: "cancelled" };
      }
      if (method !== "wizard.start") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return ++starts === 1
        ? {
            done: true,
            status: "done",
            channels: ["whatsapp"],
            accounts: [{ channel: "whatsapp", accountId: "completed-account" }],
          }
        : {
            done: false,
            status: "running",
            sessionId: "replacement",
            step: { id: "token", type: "text" },
          };
    });
    Object.assign(gateway.snapshot, {
      client: createTestGatewayClient(request),
      phase: "connected",
    });
    const channels = createChannelCapability(gateway);
    const runtimeConfig = createRuntimeConfigCapability(gateway);
    const context = { gateway, channels, runtimeConfig } as ApplicationContext;
    let currentContext = context;
    const discardDraft = vi.spyOn(runtimeConfig, "discardDraft").mockResolvedValue();
    const refresh = vi.spyOn(channels, "refresh").mockResolvedValue();
    (boundary === "reload" ? discardDraft : refresh).mockImplementation(async () => {
      operationStarted.resolve();
      await operation.promise;
    });
    const startWhatsApp = vi.spyOn(channels, "startWhatsApp").mockResolvedValue();
    const host = new ChannelWizardHost({
      getContext: () => currentContext,
      requestUpdate: () => {},
      clearSelection: () => {},
    });
    try {
      host.startSetup("whatsapp");
      await operationStarted.promise;
      if (outcome === "closed") {
        host.close();
      } else if (outcome === "disconnected") {
        host.cancelOnDisconnect();
      } else if (outcome === "replaced") {
        host.startSetup("telegram");
      } else if (outcome === "context changed") {
        currentContext = { ...context };
      }
      refresh.mockClear();
      operation.resolve();
      await vi.runAllTimersAsync();

      if (outcome === "current") {
        expect(refresh).toHaveBeenCalledWith(true);
        expect(startWhatsApp).toHaveBeenCalledWith(false, "completed-account");
        expect(host.whatsappAccountId).toBe("completed-account");
      } else {
        expect(refresh).not.toHaveBeenCalled();
        expect(startWhatsApp).not.toHaveBeenCalled();
        expect(host.whatsappAccountId).toBeUndefined();
      }
    } finally {
      operation.resolve();
      host.cancelOnDisconnect();
      await vi.runAllTimersAsync();
      channels.dispose();
      runtimeConfig.dispose();
    }
  });
});
