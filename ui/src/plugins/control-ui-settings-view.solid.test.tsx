import { expect, it, vi } from "vitest";
import type { ControlUiSettingsContext } from "../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../app/context.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { mountSettingsPresentation } from "./control-ui-settings.test-support.tsx";

type Hello = { auth: { scopes: string[]; recoveryScope: string } };

function fixture(
  options: {
    updateThrows?: boolean;
    disposeThrows?: boolean;
    retireDuringMount?: boolean;
  } = {},
) {
  const runtime = new AbortController();
  const contexts: ControlUiSettingsContext[] = [];
  const views: Array<{
    dispose: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    assets: ReturnType<typeof vi.fn>;
  }> = [];
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
        const lifetime = AbortSignal.any([signal, runtime.signal]);
        lifetime.addEventListener("abort", dispose, { once: true });
        return {
          signal: lifetime,
          dispose,
          view: {
            placement: { section: "memory", panel: "overview" },
            mount(_container: HTMLElement, context: ControlUiSettingsContext) {
              contexts.push(context);
              const stop = vi.fn(() => {
                if (options.disposeThrows) {
                  throw new Error("dispose failed");
                }
              });
              if (options.retireDuringMount && contexts.length === 1) {
                mounted.change({ agentId: "writer" });
              }
              const update = vi.fn(() => {
                if (options.updateThrows) {
                  throw new Error("update failed");
                }
              });
              views.push({ dispose: stop, update, assets: dispose });
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
    views,
    request,
    navigate,
    runtime,
    gateway,
  };
}

async function mountedFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  await waitForSolid(() => expect(f.views).toHaveLength(options.retireDuringMount ? 2 : 1));
  return f;
}

function expectDisposed(f: ReturnType<typeof fixture>) {
  expect(f.views[0]!.dispose).toHaveBeenCalledOnce();
  expect(f.views[0]!.assets).toHaveBeenCalledOnce();
}

async function expectRetired(f: ReturnType<typeof fixture>, context = f.contexts[0]!) {
  expect(context.signal.aborted).toBe(true);
  await expect(context.request("doctor.memory.status")).rejects.toThrow();
  expect(() => context.navigate("settings")).toThrow();
  expect(f.navigate).not.toHaveBeenCalled();
}

it("cleans mounted views and assets when the first update throws", async () => {
  const f = await mountedFixture({ updateThrows: true, disposeThrows: true });
  await waitForSolid(() => expectDisposed(f));
});
it("retires a later failed update before callbacks or pending replies can escape", async () => {
  const f = await mountedFixture();
  expect(f.views[0]!.update).toHaveBeenCalledOnce();
  const old = f.contexts[0]!;
  const pending = old.request("doctor.memory.status");
  f.views[0]!.update.mockImplementationOnce(() => {
    throw new Error("later update failed");
  });
  expect(() => f.change({ locale: "fr" })).not.toThrow();
  expect(f.container.textContent).toBe("later update failed");
  await expect(pending).rejects.toThrow();
  await expectRetired(f, old);
  expect(f.request).toHaveBeenCalledTimes(1);
  f.unmount();
  expectDisposed(f);
});
it("retires retained callbacks and disposes exactly once on runtime shutdown", async () => {
  const f = await mountedFixture();
  f.runtime.abort();
  expectDisposed(f);
  await expectRetired(f);
  expect(f.request).not.toHaveBeenCalled();
});
it("disposes a view that synchronously retires its authority while mounting", async () => {
  const f = await mountedFixture({ retireDuringMount: true });
  expectDisposed(f);
  expect(f.contexts[0]!.signal.aborted).toBe(true);
});
const gatewayChanges: Record<string, (gateway: ReturnType<typeof fixture>["gateway"]) => void> = {
  "client replacement": (gateway) => {
    gateway.snapshot.client = { ...gateway.snapshot.client };
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
    const old = f.contexts[0]!;
    f.change({}, () => change(f.gateway));
    expect(old.signal.aborted).toBe(true);
    expect(f.views[0]!.dispose).toHaveBeenCalledOnce();
    await expect(old.request("memory.search")).rejects.toThrow();
    await waitForSolid(() => expect(f.contexts).toHaveLength(2));
  },
);
