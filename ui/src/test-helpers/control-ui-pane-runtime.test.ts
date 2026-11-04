/* @vitest-environment jsdom */
import { expect, onTestFinished, vi } from "vitest";
import { notifyRenderLifecycleForTest } from "../pages/chat/render-lifecycle.ts";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { createControlUiPaneRuntimeTestAdapterScript } from "./control-ui-pane-runtime.test-support.ts";
import { mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it("composes existing and replacement render lifecycle instrumentation", ({ gatewayPage }) => {
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
  const owner = { element: window.document.createElement("openclaw-chat-pane") };
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  vi.stubGlobal("openclawRenderLifecycleTestHook", scope.openclawRenderLifecycleTestHook);

  notifyRenderLifecycleForTest(owner, "commit");
  expect(firstProbe).toHaveBeenCalledWith(owner, "commit");

  const streamProbe = vi.fn();
  scope.openclawRenderLifecycleTestHook = streamProbe;
  notifyRenderLifecycleForTest(owner, "commit");
  expect(firstProbe).toHaveBeenCalledTimes(1);
  expect(streamProbe).toHaveBeenCalledWith(owner, "commit");
});
