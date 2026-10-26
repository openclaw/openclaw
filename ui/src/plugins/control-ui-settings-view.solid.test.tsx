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
  const views: Array<{
    context: ControlUiSettingsContext;
    dispose: ReturnType<typeof lifecycleCallback>;
    update: ReturnType<typeof lifecycleCallback>;
  }> = [];
  const assets: ReturnType<typeof vi.fn>[] = [];
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
        assets.push(dispose);
        signal.addEventListener("abort", dispose, { once: true });
        return {
          signal,
          dispose,
          view: {
            placement: { section: "memory", panel: "overview" },
            mount(_container: HTMLElement, context: ControlUiSettingsContext) {
              const view = {
                context,
                dispose: lifecycleCallback("dispose", options.disposeThrows),
                update: lifecycleCallback("update", options.updateThrows),
              };
              views.push(view);
              if (options.retireDuringMount && views.length === 1) {
                mounted.change({ agentId: "writer" });
              }
              return view;
            },
          },
        };
      },
    },
  } as unknown as ApplicationContext;
  const mounted = mountSettingsPresentation(application, {}, navigate);
  return { ...mounted, views, assets, request, navigate, gateway };
}

async function mountedFixture() {
  const f = fixture();
  await waitForSolid(() => expect(f.views).toHaveLength(1));
  return { ...f, ...f.views[0]! };
}

it("cleans mounted views and assets when the first update throws", async () => {
  const f = fixture({ updateThrows: true, disposeThrows: true });
  await waitForSolid(() => expect(f.assets[0]).toHaveBeenCalledTimes(1));
  expect(f.views[0]!.dispose).toHaveBeenCalledTimes(1);
});
it("retires a later failed update before callbacks or pending replies can escape", async () => {
  const f = await mountedFixture();
  await waitForSolid(() => expect(f.update).toHaveBeenCalledTimes(1));
  const pending = f.context.request("doctor.memory.status");
  f.update.mockImplementationOnce(() => {
    throw new Error("later update failed");
  });
  expect(() => f.change({ locale: "fr" })).not.toThrow();
  expect(f.context.signal.aborted).toBe(true);
  expect(f.container.textContent).toBe("later update failed");
  await expect(pending).rejects.toThrow();
  await expect(f.context.request("doctor.memory.status")).rejects.toThrow();
  expect(() => f.context.navigate("settings")).toThrow();
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.navigate).not.toHaveBeenCalled();
  f.unmount();
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(f.assets[0]).toHaveBeenCalledTimes(1);
});
it("retires callbacks and disposes an inactive placement once", async () => {
  const f = await mountedFixture();
  f.retire();
  expect(f.context.signal.aborted).toBe(true);
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.assets[0]).toHaveBeenCalledOnce();
  f.notify();
  expect(f.assets).toHaveLength(1);
  await expect(f.context.request("doctor.memory.status")).rejects.toThrow();
  expect(() => f.context.navigate("settings")).toThrow();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
  f.unmount();
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(f.assets[0]).toHaveBeenCalledOnce();
});
it("disposes a view that synchronously retires its authority while mounting", async () => {
  const f = fixture({ retireDuringMount: true });
  await waitForSolid(() => expect(f.views).toHaveLength(2));
  expect(f.views[0]!.dispose).toHaveBeenCalledTimes(1);
  expect(f.assets[0]).toHaveBeenCalledTimes(1);
  expect(f.views[0]!.context.signal.aborted).toBe(true);
});
const gatewayChanges: Record<string, (gateway: ReturnType<typeof fixture>["gateway"]) => void> = {
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
    expect(f.context.signal.aborted).toBe(true);
    expect(f.dispose).toHaveBeenCalledTimes(1);
    await expect(f.context.request("memory.search")).rejects.toThrow();
    await waitForSolid(() => expect(f.views).toHaveLength(2));
  },
);
