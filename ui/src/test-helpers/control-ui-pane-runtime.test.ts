/* @vitest-environment jsdom */
import { expect, onTestFinished, vi } from "vitest";
import { ChatPaneRuntime } from "../pages/chat/chat-pane-render.ts";
import { createTestChatPane } from "../pages/chat/chat-pane.test-support.ts";
import { notifyRenderLifecycleForTest } from "../pages/chat/render-lifecycle.ts";
import { SessionSnapshotStore } from "../pages/chat/session-snapshot-store.ts";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { createControlUiPaneRuntimeTestAdapterScript } from "./control-ui-pane-runtime.test-support.ts";
import { createTestGatewayClient } from "./gateway-client.ts";
import { mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it("keeps private pane probes on the reported runtime while composing stream instrumentation", ({
  gatewayPage,
}) => {
  const { window, execute } = gatewayPage;
  // SAFETY: The isolated page installs the existing opt-in instrumentation property.
  const scope = window as typeof window & {
    openclawRenderLifecycleTestHook?: typeof notifyRenderLifecycleForTest;
  };
  const firstProbe = vi.fn();
  scope.openclawRenderLifecycleTestHook = firstProbe;
  execute(createControlUiPaneRuntimeTestAdapterScript());
  const adapter = scope.openclawRenderLifecycleTestHook;
  execute(createControlUiMockGatewayInitScript());
  expect(scope.openclawRenderLifecycleTestHook).toBe(adapter);
  const fixture = createTestChatPane({ client: createTestGatewayClient(() => ({})) });
  const element = window.document.createElement("openclaw-chat-pane");
  let snapshots = new SessionSnapshotStore();
  const snapshotProperty = {
    configurable: true,
    get: () => snapshots,
    set: (next: SessionSnapshotStore) => {
      snapshots = next;
    },
  };
  Object.defineProperty(element, "sessionSnapshotStore", snapshotProperty);
  const commitFence = Promise.resolve();
  Reflect.set(element, "updateComplete", commitFence);
  const runtime = new ChatPaneRuntime(element, fixture.pane.context);
  Reflect.set(runtime, "state", fixture.state);
  onTestFinished(() => {
    runtime.disconnectedCallback();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  vi.stubGlobal("openclawRenderLifecycleTestHook", scope.openclawRenderLifecycleTestHook);

  notifyRenderLifecycleForTest(runtime, "commit");
  expect(Reflect.get(element, "state")).toBe(fixture.state);
  expect(Reflect.get(element, "chatState")).toBe(Reflect.get(runtime, "chatState"));
  expect(Reflect.get(element, "context")).toBe(fixture.pane.context);
  expect(Reflect.get(element, "presencePayload")).toBeUndefined();
  expect(firstProbe).toHaveBeenCalledWith(runtime, "commit");
  expect(Reflect.get(element, "updateComplete")).toBe(commitFence);
  expect(Object.getOwnPropertyDescriptor(element, "sessionSnapshotStore")).toMatchObject(
    snapshotProperty,
  );
  const nextSnapshots = new SessionSnapshotStore();
  expect(Reflect.set(element, "sessionSnapshotStore", nextSnapshots)).toBe(true);
  expect(Reflect.get(element, "sessionSnapshotStore")).toBe(nextSnapshots);

  const suggestions: [] = [];
  Reflect.set(runtime, "taskSuggestions", suggestions);
  Reflect.set(runtime, "loadingOlder", true);
  Reflect.set(runtime, "historyIntentTimer", 37);
  const presence = { presence: [] };
  Reflect.set(runtime, "presencePayload", presence);
  expect(Reflect.get(element, "taskSuggestions")).toBe(suggestions);
  expect(Reflect.get(element, "loadingOlder")).toBe(true);
  expect(Reflect.get(element, "historyIntentTimer")).toBe(37);
  expect(Reflect.get(element, "presencePayload")).toBe(presence);
  const boardProviderLease = { update: vi.fn() };
  Reflect.set(runtime, "boardProviderLease", boardProviderLease);
  expect(Reflect.get(element, "boardProviderLease")).toBe(boardProviderLease);
  Reflect.set(runtime, "boardProviderLease", undefined);
  expect(Reflect.get(element, "boardProviderLease")).toBeUndefined();
  Reflect.set(runtime, "loadingOlder", false);
  Reflect.set(runtime, "historyIntentTimer", null);
  expect(Reflect.get(element, "loadingOlder")).toBe(false);
  expect(Reflect.get(element, "historyIntentTimer")).toBeNull();

  const streamProbe = vi.fn();
  scope.openclawRenderLifecycleTestHook = streamProbe;
  Reflect.set(runtime, "state", undefined);
  notifyRenderLifecycleForTest(runtime, "invalidate");
  expect(Reflect.get(element, "state")).toBeUndefined();
  expect(firstProbe).toHaveBeenCalledTimes(1);
  expect(streamProbe).toHaveBeenCalledWith(runtime, "invalidate");

  for (const key of ["requestUpdate", "render"] as const) {
    const ownerMethod = vi.spyOn(runtime, key);
    const original: unknown = Reflect.get(element, key);
    if (typeof original !== "function") {
      throw new Error(`Expected the recorded pane's ${key} operation`);
    }
    let probeCalls = 0;
    Reflect.set(element, key, (...args: unknown[]) => {
      probeCalls += 1;
      if (probeCalls > 1) {
        throw new Error("The saved owner method recursed through its replacement");
      }
      return Reflect.apply(original, element, args);
    });
    const instrumented: unknown = Reflect.get(element, key);
    if (typeof instrumented !== "function") {
      throw new Error(`Expected the instrumented pane's ${key} operation`);
    }
    const args = key === "requestUpdate" ? ["sessionKey", "previous"] : [];
    const result: unknown = Reflect.apply(instrumented, element, args);
    if (key === "render") {
      expect(result).toHaveProperty("layout");
    }
    expect(probeCalls).toBe(1);
    expect(ownerMethod).toHaveBeenCalledWith(...args);
    expect(ownerMethod.mock.instances[0]).toBe(runtime);
  }
});
