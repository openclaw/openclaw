import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type {
  ControlUiSessionBadge,
  ControlUiSessionBadgeAccessory,
} from "../../../src/plugin-sdk/control-ui.js";
import { createApplicationConfigCapability } from "../app/config.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createInitializationContext,
  createGatewayBrowserClientFixture,
} from "../pages/chat/chat-application-context.test-support.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../test-helpers/application-context-fixtures.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import * as loader from "./control-ui-loader.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import { SessionAccessoryBadges } from "./control-ui-session-badges.solid.tsx";
import { readSessionBadges, type SessionBadgeCaptureContext } from "./control-ui-session-badges.ts";

it("shares passive live/cache facts and retires observers with the current registration", async () => {
  let descriptors: PluginControlUiModule[] = [
    {
      pluginId: "review",
      name: "Review",
      revision: "one",
      entryUrl: "/review.js",
      styles: [],
      uiCapabilities: ["accessory"],
    },
  ];
  const request = vi.fn(async (method: string) =>
    method === "plugins.controlUi.list"
      ? { revision: "catalog", plugins: descriptors, diagnostics: [] }
      : { ok: true },
  );
  const client = createGatewayBrowserClientFixture({
    gatewayUrl: location.origin.replace(/^http/u, "ws"),
    request,
  });
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello: gatewayHelloForMethods(
        ["plugins.controlUi.list", "plugins.controlUi.report"],
        ["operator.read"],
      ),
    }),
  );
  const configuration = createApplicationConfigCapability({ resourceBasePath: "" });
  let context: ApplicationContext = {
    ...createInitializationContext(client),
    gateway,
    config: {
      ...configuration,
      refresh: async () => ({
        ...configuration.current,
        pluginAssetsRequireAuth: false,
        pluginFrameGrants: [],
      }),
    },
  };
  let fact: ControlUiSessionBadge = {
    icon: "check",
    label: "1 check",
    tone: "positive",
    state: "ready",
  };
  let changed = () => {};
  let observers = 0;
  let admissions = 0;
  let releases = 0;
  let observerSignal: AbortSignal | undefined;
  let failedObserverSignal: AbortSignal | undefined;
  let failObserverSetup = true;
  let failure: Error | undefined;
  let pending = false;
  let absent = false;
  const resolve = vi.fn<ControlUiSessionBadgeAccessory["resolve"]>(() => {
    if (failure) {
      throw failure;
    }
    return pending ? { status: "pending" } : { status: "ready", badge: absent ? undefined : fact };
  });
  const initialize = vi
    .spyOn(loader, "initializeControlUiPlugin")
    .mockImplementation(async (getContext, runtime, owner) => {
      const host = createControlUiPluginHost(getContext, runtime, owner);
      host.ui.registerAccessory({
        id: "checks",
        placement: "session-row",
        presentation: "badge",
        resolve,
        observe(target, notify) {
          if (failObserverSetup) {
            failObserverSetup = false;
            failedObserverSignal = target.signal;
            throw new Error("Synthetic observer setup failure");
          }
          observerSignal = target.signal;
          observers += 1;
          admissions += 1;
          changed = notify;
          notify();
          return () => {
            observers -= 1;
            releases += 1;
          };
        },
      });
      return Object.assign(owner, { host });
    });
  onTestFinished(() => initialize.mockRestore());
  const runtime = new ControlUiPluginRuntime(() => context);
  context = { ...context, plugins: runtime };
  onTestFinished(() => runtime.dispose());
  runtime.start();
  await runtime.refresh();
  expect(runtime.errors).toEqual([]);
  const target = { sessionKey: "agent:main:one", artifact: { numbers: [1] } };
  const [row, setRow] = createSignal(target);
  const [handlers, setHandlers] = createSignal({ onChange: () => {} });
  // A failed setup retires that observer; another mount can admit its own lease.
  const failed = mountSolid(() => <SessionAccessoryBadges plugins={runtime} {...target} />);
  await waitForSolid(() => expect(failedObserverSignal?.aborted).toBe(true));
  expect(observers).toBe(0);
  failed.unmount();
  // Native sidebar row roots receive capabilities without a Solid application provider.
  const live = mountSolid(() => (
    <SessionAccessoryBadges plugins={runtime} {...row()} onChange={handlers().onChange} />
  ));
  await waitForSolid(() =>
    expect(live.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "1 check",
    ),
  );
  expect(failedObserverSignal?.aborted).toBe(true);
  expect(runtime.errors).toContainEqual(
    expect.objectContaining({ pluginId: "review", message: "Synthetic observer setup failure" }),
  );
  expect(observers).toBe(1);
  const initialAdmissions = admissions;
  setRow({ ...target, artifact: { numbers: [1] } });
  await waitForSolid(() => expect(admissions).toBe(initialAdmissions));
  await runtime.refresh();
  await waitForSolid(() => expect(admissions).toBe(initialAdmissions));
  setHandlers({ onChange: () => {} });
  await waitForSolid(() => expect(admissions).toBe(initialAdmissions));
  expect(observers).toBe(1);
  expect(observerSignal?.aborted).toBe(false);
  fact = { ...fact, label: "2 checks", count: 2 };
  changed();
  await waitForSolid(() =>
    expect(live.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "2 checks",
    ),
  );
  failure = new Error("Synthetic badge failure");
  changed();
  await waitForSolid(() => expect(live.container.querySelector('[role="img"]')).toBeNull());
  expect(runtime.errors).toContainEqual(
    expect.objectContaining({ pluginId: "review", message: "Synthetic badge failure" }),
  );
  failure = undefined;
  changed();
  await waitForSolid(() =>
    expect(live.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "2 checks",
    ),
  );
  const targets: SessionBadgeCaptureContext["nextTargets"] = new Map();
  const cached = readSessionBadges(runtime, target, [], { nextTargets: targets });
  const capture: SessionBadgeCaptureContext = { previousTargets: targets, nextTargets: new Map() };
  expect(cached).toEqual([{ pluginId: "review", id: "checks", ...fact }]);
  pending = true;
  changed();
  expect(readSessionBadges(runtime, target, cached)).toEqual([]);
  expect(readSessionBadges(runtime, target, cached, capture)).toEqual(cached);
  expect(
    readSessionBadges(runtime, { ...target, worktreeId: "another-checkout" }, cached, capture),
  ).toEqual([]);
  expect(
    readSessionBadges(runtime, { ...target, artifact: { numbers: [2] } }, cached, capture),
  ).toEqual([]);
  await waitForSolid(() =>
    expect(live.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "2 checks",
    ),
  );
  pending = false;
  absent = true;
  changed();
  expect(readSessionBadges(runtime, target, cached, capture)).toEqual([]);
  await waitForSolid(() => expect(live.container.querySelector('[role="img"]')).toBeNull());
  absent = false;
  changed();
  await waitForSolid(() =>
    expect(live.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "2 checks",
    ),
  );
  pending = true;
  descriptors = descriptors.map((descriptor) => Object.assign({}, descriptor, { revision: "two" }));
  await runtime.refresh();
  expect(readSessionBadges(runtime, target, cached, capture)).toEqual([]);
  pending = false;
  live.unmount();
  expect(observerSignal?.aborted).toBe(true);
  expect(observers).toBe(0);
  expect(releases).toBe(admissions);

  // A fresh runtime has no active catalog or code; cached presentation must not invoke the former producer.
  const nextRuntime = new ControlUiPluginRuntime(() => context);
  context = { ...context, plugins: nextRuntime };
  onTestFinished(() => nextRuntime.dispose());
  const calls = resolve.mock.calls.length;
  const restored = mountSolid(() => (
    <SessionAccessoryBadges plugins={nextRuntime} {...target} cached={cached} />
  ));
  await waitForSolid(() =>
    expect(restored.container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "2 checks",
    ),
  );
  expect(resolve).toHaveBeenCalledTimes(calls);
  expect(observers).toBe(0);
  descriptors = [];
  nextRuntime.start();
  await nextRuntime.refresh();
  await waitForSolid(() => expect(restored.container.querySelector('[role="img"]')).toBeNull());
  expect(resolve).toHaveBeenCalledTimes(calls);
  expect(readSessionBadges(nextRuntime, target, cached)).toEqual([]);
  expect(
    request.mock.calls.every(
      ([method]) => method === "plugins.controlUi.list" || method === "plugins.controlUi.report",
    ),
  ).toBe(true);
  restored.unmount();
});
