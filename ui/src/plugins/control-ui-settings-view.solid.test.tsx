import { expect, it, vi } from "vitest";
import type { ControlUiSettingsContext } from "../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../app/context.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { mountSettingsPresentation } from "./control-ui-settings.test-support.tsx";

type Hello = { auth: { scopes: string[]; recoveryScope: string } };
const lifecycleCallback = (phase: string, fails = false) =>
  vi.fn(() => {
    if (fails) {
      throw new Error(`${phase} failed`);
    }
  });

function fixture(
  options: {
    updateThrows?: boolean;
    disposeThrows?: boolean;
    retireDuringMount?: boolean;
  } = {},
) {
  const runtime = new AbortController();
  const contexts: ControlUiSettingsContext[] = [];
  const viewDisposers: ReturnType<typeof vi.fn>[] = [];
  const viewUpdates: ReturnType<typeof vi.fn>[] = [];
  const assetDisposers: ReturnType<typeof vi.fn>[] = [];
  const request = vi.fn(async () => "current");
  const navigate = vi.fn();
  const gateway = {
    connectionRevision: 1,
    snapshot: {
      phase: "connected",
      hello: {
        auth: { scopes: ["operator.read"], recoveryScope: "account-a" },
      } as Hello | null,
      client: { request, recoveryScopeReady: true, offlineRecoveryRetired: false },
    },
  };
  const application = {
    gateway,
    plugins: {
      reportError: vi.fn(),
      async loadSettingsView(_placement: unknown, signal: AbortSignal) {
        const dispose = vi.fn();
        assetDisposers.push(dispose);
        const lifetime = AbortSignal.any([signal, runtime.signal]);
        lifetime.addEventListener("abort", dispose, { once: true });
        return {
          signal: lifetime,
          dispose,
          view: {
            placement: { section: "memory", panel: "overview" },
            mount(_container: HTMLElement, context: ControlUiSettingsContext) {
              contexts.push(context);
              const stop = lifecycleCallback("dispose", options.disposeThrows);
              viewDisposers.push(stop);
              if (options.retireDuringMount && contexts.length === 1) {
                mounted.change({ agentId: "writer" });
              }
              const update = lifecycleCallback("update", options.updateThrows);
              viewUpdates.push(update);
              return { update, dispose: stop };
            },
          },
        };
      },
    },
  } as unknown as ApplicationContext;
  const mounted = mountSettingsPresentation(application, {}, navigate);
  return {
    ...mounted,
    contexts,
    viewDisposers,
    viewUpdates,
    assetDisposers,
    request,
    navigate,
    runtime,
    gateway,
  };
}

async function mountedFixture() {
  const f = fixture();
  await waitForSolid(() => expect(f.contexts).toHaveLength(1));
  return { ...f, old: f.contexts[0]! };
}

it("cleans mounted views and assets when the first update throws", async () => {
  const f = fixture({ updateThrows: true, disposeThrows: true });
  await waitForSolid(() => expect(f.assetDisposers[0]).toHaveBeenCalledTimes(1));
  expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
});
it("retires a later failed update before callbacks or pending replies can escape", async () => {
  const f = fixture();
  await waitForSolid(() => expect(f.viewUpdates[0]).toHaveBeenCalledTimes(1));
  const old = f.contexts[0]!;
  const pending = old.request("doctor.memory.status");
  f.viewUpdates[0]!.mockImplementationOnce(() => {
    throw new Error("later update failed");
  });
  expect(() => f.change({ locale: "fr" })).not.toThrow();
  expect(old.signal.aborted).toBe(true);
  expect(f.container.textContent).toBe("later update failed");
  await expect(pending).rejects.toThrow();
  await expect(old.request("doctor.memory.status")).rejects.toThrow();
  expect(() => old.navigate("settings")).toThrow();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.navigate).not.toHaveBeenCalled();
  f.unmount();
  expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
  expect(f.assetDisposers[0]).toHaveBeenCalledTimes(1);
});
it.each(["runtime shutdown", "inactive placement"])(
  "retires callbacks and disposes once on %s",
  async (cause) => {
    const f = await mountedFixture();
    if (cause === "runtime shutdown") {
      f.runtime.abort();
    } else {
      f.retire();
    }
    expect(f.old.signal.aborted).toBe(true);
    expect(f.viewDisposers[0]).toHaveBeenCalledOnce();
    expect(f.assetDisposers[0]).toHaveBeenCalledOnce();
    if (cause === "inactive placement") {
      f.notify();
    }
    await waitForSolid(() => expect(f.assetDisposers).toHaveLength(1));
    await expect(f.old.request("doctor.memory.status")).rejects.toThrow();
    expect(() => f.old.navigate("settings")).toThrow();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.navigate).not.toHaveBeenCalled();
    f.unmount();
    expect(f.viewDisposers[0]).toHaveBeenCalledOnce();
    expect(f.assetDisposers[0]).toHaveBeenCalledOnce();
  },
);
it("disposes a view that synchronously retires its authority while mounting", async () => {
  const f = fixture({ retireDuringMount: true });
  await waitForSolid(() => expect(f.contexts).toHaveLength(2));
  expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
  expect(f.assetDisposers[0]).toHaveBeenCalledTimes(1);
  expect(f.contexts[0]!.signal.aborted).toBe(true);
});
const gatewayChanges: Record<string, (gateway: ReturnType<typeof fixture>["gateway"]) => void> = {
  "client replacement": (gateway) => {
    gateway.snapshot.client = { ...gateway.snapshot.client };
  },
  "recovery-scope change": (gateway) => {
    gateway.snapshot.hello!.auth.recoveryScope = "account-b";
  },
  "retired offline recovery": (gateway) => {
    gateway.snapshot.client.offlineRecoveryRetired = true;
  },
  "connect rejection": (gateway) => {
    gateway.snapshot.phase = "reconnecting";
    gateway.snapshot.hello = null;
  },
};
it.each(Object.entries(gatewayChanges))(
  "disposes the mounted view after %s",
  async (_cause, change) => {
    const f = await mountedFixture();
    f.change({}, () => change(f.gateway));
    expect(f.old.signal.aborted).toBe(true);
    expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
    await expect(f.old.request("memory.search")).rejects.toThrow();
    await waitForSolid(() => expect(f.contexts).toHaveLength(2));
  },
);
