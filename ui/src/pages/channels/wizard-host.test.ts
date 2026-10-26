import { createRoot } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createChannelSetup } from "./wizard-setup.ts";

afterEach(() => vi.useRealTimers());

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
  let starts = 0;
  const request = async (method: string) => {
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
          accounts: [{ channel: "whatsapp", accountId: "completed-account" }],
        }
      : {
          done: false,
          status: "running",
          sessionId: "replacement",
          step: { id: "token", type: "text" },
        };
  };
  const refresh = vi.fn().mockResolvedValue(undefined);
  const discardDraft = vi.fn().mockResolvedValue(undefined);
  const startWhatsApp = vi.fn().mockResolvedValue(undefined);
  const context = {
    gateway: { snapshot: { client: { request }, phase: "connected" } },
    channels: { state: { channelsSnapshot: null }, refresh },
    runtimeConfig: { state: { configFormDirty: false }, discardDraft },
  } as ApplicationContext;
  let currentContext = context;
  (boundary === "reload" ? discardDraft : refresh).mockImplementation(async () => {
    operationStarted.resolve();
    await operation.promise;
  });
  let dispose!: () => void;
  const host = createRoot((stop) => {
    dispose = stop;
    return createChannelSetup({
      getContext: () => currentContext,
      clearSelection: () => {},
      presentWizard: async (pending) => await pending,
      retire: () => {},
      startWhatsApp,
    });
  });
  try {
    host.startSetup("whatsapp");
    await operationStarted.promise;
    if (outcome === "closed") {
      host.close();
    } else if (outcome === "disconnected") {
      dispose();
    } else if (outcome === "replaced") {
      host.startSetup("telegram");
    } else if (outcome === "context changed") {
      currentContext = { ...context };
    }
    refresh.mockClear();
    operation.resolve();
    await vi.runAllTimersAsync();

    const current = outcome === "current";
    expect(refresh.mock.calls).toEqual(current ? [[true]] : []);
    expect(startWhatsApp.mock.calls).toEqual(current ? [[false, "completed-account"]] : []);
    expect(host.whatsappAccountId()).toBe(current ? "completed-account" : undefined);
  } finally {
    operation.resolve();
    dispose();
    await vi.runAllTimersAsync();
  }
});
