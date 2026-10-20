import { expect, it, vi } from "vitest";
import type {
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
} from "../../../src/plugin-sdk/control-ui-settings.js";
import type { ApplicationContext } from "../app/context.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { ControlUiSettingsPresentation } from "./control-ui-settings-view.solid.tsx";

function fixture(
  options: {
    scopes?: string[];
    updateThrows?: boolean;
    disposeThrows?: boolean;
    retireDuringMount?: boolean;
  } = {},
) {
  let snapshot: ControlUiSettingsSnapshot = {
    agentId: "main",
    agentsLoading: false,
    agentsError: null,
    engine: { kind: "default", id: "memory-core", availability: "enabled" },
    connected: true,
    connectionEpoch: 1,
    routeIntent: "overview",
    locale: "en",
  };
  const listeners = new Set<() => void>();
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
      hello: { auth: { scopes: options.scopes ?? ["operator.read"], recoveryScope: "account-a" } },
      client: { request, recoveryScopeReady: true, offlineRecoveryRetired: false },
    } as {
      phase: string;
      hello: { auth: { scopes: string[]; recoveryScope: string } } | null;
      client: {
        request: typeof request;
        recoveryScopeReady: boolean;
        offlineRecoveryRetired: boolean;
      };
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
              const stop = vi.fn(() => {
                if (options.disposeThrows) {
                  throw new Error("dispose failed");
                }
              });
              viewDisposers.push(stop);
              if (options.retireDuringMount && contexts.length === 1) {
                change({ agentId: "writer" });
              }
              const update = vi.fn(() => {
                if (options.updateThrows) {
                  throw new Error("update failed");
                }
              });
              viewUpdates.push(update);
              return { update, dispose: stop };
            },
          },
        };
      },
    },
  } as unknown as ApplicationContext;
  function change(
    patch: Partial<ControlUiSettingsSnapshot>,
    gatewayPatch: (current: typeof gateway) => void = () => {},
  ) {
    snapshot = { ...snapshot, ...patch };
    gatewayPatch(gateway);
    for (const notify of listeners) {
      notify();
    }
  }
  const mounted = mountSolid(() => (
    <ControlUiSettingsPresentation
      application={application}
      placement={{ section: "memory", panel: "overview" }}
      readSnapshot={() => snapshot}
      subscribe={(notify) => {
        listeners.add(notify);
        return () => listeners.delete(notify);
      }}
      navigate={navigate}
      refreshAgents={vi.fn()}
    />
  ));
  return {
    ...mounted,
    contexts,
    viewDisposers,
    viewUpdates,
    assetDisposers,
    request,
    navigate,
    runtime,
    change,
    gateway,
  };
}

it("checks actual Gateway operator scopes before dispatch", async () => {
  const f = fixture({ scopes: [] });
  await waitForSolid(() => expect(f.contexts).toHaveLength(1));
  await expect(f.contexts[0]!.request("doctor.memory.status")).rejects.toThrow("operator access");
  expect(f.request).not.toHaveBeenCalled();
});
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
it("retires retained callbacks and disposes exactly once on runtime shutdown", async () => {
  const f = fixture();
  await waitForSolid(() => expect(f.contexts).toHaveLength(1));
  const old = f.contexts[0]!;
  f.runtime.abort();
  expect(old.signal.aborted).toBe(true);
  expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
  expect(f.assetDisposers[0]).toHaveBeenCalledTimes(1);
  await expect(old.request("doctor.memory.status")).rejects.toThrow();
  expect(() => old.navigate("settings")).toThrow();
  expect(f.request).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
});
it.each(["agent", "engine", "route"])(
  "rejects a retained callback after %s changes",
  async (kind) => {
    const f = fixture();
    await waitForSolid(() => expect(f.contexts).toHaveLength(1));
    const old = f.contexts[0]!;
    const patch: Partial<ControlUiSettingsSnapshot> =
      kind === "agent"
        ? { agentId: "writer" }
        : kind === "engine"
          ? { engine: { kind: "pinned", id: "custom-memory", availability: "unknown" } }
          : { routeIntent: "overview?agent=writer" };
    f.change(patch);
    await expect(old.request("doctor.memory.status")).rejects.toThrow();
    expect(() => old.navigate("settings")).toThrow();
    expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
  },
);
it("disposes a view that synchronously retires its authority while mounting", async () => {
  const f = fixture({ retireDuringMount: true });
  await waitForSolid(() => expect(f.contexts).toHaveLength(2));
  expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
  expect(f.assetDisposers[0]).toHaveBeenCalledTimes(1);
  expect(f.contexts[0]!.signal.aborted).toBe(true);
});
it.each([
  [
    "client replacement",
    (gateway: ReturnType<typeof fixture>["gateway"]) => {
      gateway.snapshot.client = { ...gateway.snapshot.client };
    },
  ],
  [
    "recovery-scope change",
    (gateway: ReturnType<typeof fixture>["gateway"]) => {
      gateway.snapshot.hello!.auth.recoveryScope = "account-b";
    },
  ],
  [
    "retired offline recovery",
    (gateway: ReturnType<typeof fixture>["gateway"]) => {
      gateway.snapshot.client.offlineRecoveryRetired = true;
    },
  ],
  [
    "connect rejection",
    (gateway: ReturnType<typeof fixture>["gateway"]) => {
      gateway.snapshot.phase = "reconnecting";
      gateway.snapshot.hello = null;
    },
  ],
])("disposes the mounted view after %s", async (_cause, retireGateway) => {
  const f = fixture();
  await waitForSolid(() => expect(f.contexts).toHaveLength(1));
  const old = f.contexts[0]!;
  f.change({}, retireGateway);
  expect(old.signal.aborted).toBe(true);
  expect(f.viewDisposers[0]).toHaveBeenCalledTimes(1);
  await expect(old.request("memory.search")).rejects.toThrow();
  await waitForSolid(() => expect(f.contexts).toHaveLength(2));
});
