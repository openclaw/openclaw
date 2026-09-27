import { createRouter, definePage } from "@openclaw/uirouter";
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RouteId } from "../app-route-paths.ts";
import { createBackgroundTasksProps } from "../pages/chat/components/chat-background-tasks.ts";
import { renderChatTasksPanel } from "../pages/chat/components/chat-tasks-panel.ts";
import { scheduleControlUiAfterPaint } from "../pages/chat/performance.ts";
import { createHost } from "../test-helpers/chat-background-tasks.ts";
import {
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
} from "./gateway-store.test-support.ts";
import { startNativePresentation } from "./native-presentation.runtime.ts";
import { NATIVE_PRESENTATION_REQUEST_EVENT } from "./native-web-chrome.ts";

afterEach(async () => {
  vi.useRealTimers();
  document.body.replaceChildren();
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
});

it("waits through real after-paint Tasks admission, then fences route replay and disposal", async () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const paint = async () => {
    vi.advanceTimersToNextFrame();
    await vi.dynamicImportSettled();
  };
  const postMessage = vi.fn();
  vi.stubGlobal("__OPENCLAW_NATIVE_PANEL__", { postMessage });
  const response = createDeferred<unknown>();
  const nextRoute = createDeferred();
  const { host, request, requestUpdate } = createHost({ request: () => response.promise });
  let admitted = false;
  host.chatSecondaryReadsReady = () => admitted;
  const mount = document.body.appendChild(document.createElement("div"));
  const draw = () =>
    render(
      renderChatTasksPanel({ host, backgroundTasks: createBackgroundTasksProps(host) }),
      mount,
    );
  requestUpdate.mockImplementation(() => queueMicrotask(draw));
  const router = createRouter<RouteId, undefined>({
    routes: [
      definePage({ id: "panel-embed", path: "/apps/panel", component: () => ({}) }),
      definePage({
        id: "settings",
        path: "/settings",
        component: () => ({}),
        loader: () => nextRoute.promise,
      }),
    ],
  });
  await router.navigate("panel-embed", undefined);
  const store = createGatewayStoreTestStore();
  store.gateway.start();
  store.current().opts.onHello?.(GATEWAY_STORE_TEST_HELLO);
  draw();
  const stop = startNativePresentation({ router, gateway: store.gateway });
  try {
    expect(createBackgroundTasksProps(host)).toMatchObject({ tasks: null, loading: false });
    scheduleControlUiAfterPaint({}, () => {
      admitted = true;
      draw();
    });
    await paint();
    await paint();
    expect(request).toHaveBeenCalledWith("tasks.list", expect.anything());
    await paint();
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ phase: "ready" }));
    response.resolve({ tasks: [] });
    await vi.dynamicImportSettled();
    for (let frame = 0; frame < 3; frame++) {
      await paint();
    }
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "ready", pathname: "/apps/panel" }),
    );
    expect(mount.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    expect(mount.querySelector("openclaw-panel-empty-state")).not.toBeNull();
    const navigation = router.navigate("settings", undefined);
    window.dispatchEvent(new Event(NATIVE_PRESENTATION_REQUEST_EVENT));
    await paint();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "loading", pathname: "/settings" }),
    );
    nextRoute.resolve();
    await navigation;
    stop();
    const count = postMessage.mock.calls.length;
    window.dispatchEvent(new Event(NATIVE_PRESENTATION_REQUEST_EVENT));
    await paint();
    expect(postMessage).toHaveBeenCalledTimes(count);
  } finally {
    stop();
    router.stop();
    store.gateway.stop();
  }
});
