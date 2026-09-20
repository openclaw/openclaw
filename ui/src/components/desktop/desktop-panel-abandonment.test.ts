/* @vitest-environment jsdom */

import type { DesktopObserveResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient, DesktopConnectionHandle } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
  settleTasks,
} from "./desktop-panel.test-support.ts";

const observed: DesktopObserveResult = {
  transport: "rfb",
  wsPath: `/desktop/observe?token=${"a".repeat(48)}`,
  expiresAtMs: 60_000,
  control: false,
  preauthenticated: true,
};

function desktopRequests(result: DesktopObserveResult | Promise<DesktopObserveResult>) {
  return vi.fn(async (method: string, _params?: unknown) => {
    if (method === "environments.list") {
      return { environments: [desktopEnvironment] };
    }
    if (method === "desktop.observe") {
      return result;
    }
    if (method === "desktop.release") {
      return { released: true };
    }
    throw new Error(`Unexpected Desktop request: ${method}`);
  });
}

async function openPanel(
  request: ReturnType<typeof desktopRequests>,
  connect: DesktopClient["connect"],
) {
  const panel = createPanel();
  panel.client = createGatewayClient(request).client;
  panel.available = true;
  panel.embedded = true;
  panel.presented = true;
  panel.desktopClientFactory = () => ({ connect });
  document.body.append(panel);
  await waitForFast(() =>
    expect(panel.renderRoot.querySelector(".desktop-environment button")).not.toBeNull(),
  );
  clickPanelButton(panel);
  await waitForFast(() =>
    expect(request.mock.calls.filter(([method]) => method === "desktop.observe")).toHaveLength(1),
  );
  return panel;
}

describe("Desktop observe abandonment", () => {
  beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["hidden", "removed", "Gateway replaced"] as const)(
    "releases a late observe through its original client after the panel is %s",
    async (change) => {
      const observation = createDeferred<DesktopObserveResult>();
      const request = desktopRequests(observation.promise);
      const replacementRequest = desktopRequests(observed);
      const connect = vi.fn(async () => createConnectionHandle());
      const panel = await openPanel(request, connect);
      const originalClient = panel.client;
      if (change === "hidden") {
        panel.presented = false;
      } else if (change === "removed") {
        panel.remove();
      } else {
        panel.client = createGatewayClient(replacementRequest).client;
      }
      await panel.updateComplete;
      observation.resolve(observed);
      await settleTasks();

      expect(request.mock.calls.filter(([method]) => method === "desktop.release")).toEqual([
        ["desktop.release", { wsPath: observed.wsPath }],
      ]);
      expect(connect).not.toHaveBeenCalled();
      expect(replacementRequest.mock.calls.some(([method]) => method === "desktop.release")).toBe(
        false,
      );
      expect(panel.isConnected).toBe(change !== "removed");
      if (change !== "Gateway replaced") {
        expect(panel.client).toBe(originalClient);
      }
    },
  );

  it("retains a credential-waiting observation until the panel closes", async () => {
    const request = desktopRequests({ ...observed, auth: "vnc-password", preauthenticated: false });
    const connect = vi.fn(async () => createConnectionHandle());
    const panel = await openPanel(request, connect);
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".desktop-credentials")).not.toBeNull(),
    );
    expect(request.mock.calls.some(([method]) => method === "desktop.release")).toBe(false);
    panel.presented = false;
    await panel.updateComplete;
    panel.remove();
    await settleTasks();

    expect(request.mock.calls.filter(([method]) => method === "desktop.release")).toEqual([
      ["desktop.release", { wsPath: observed.wsPath }],
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(["pending", "returned"] as const)(
    "releases before RFB authentication while the connection handle is %s",
    async (handleState) => {
      const result = createDeferred<DesktopConnectionHandle>();
      const handle = createConnectionHandle();
      const request = desktopRequests(observed);
      const connect = vi.fn(async () => result.promise);
      const panel = await openPanel(request, connect);
      try {
        await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
        if (handleState === "returned") {
          result.resolve(handle);
          await settleTasks();
        }
        expect(request.mock.calls.some(([method]) => method === "desktop.release")).toBe(false);
        panel.presented = false;
        await panel.updateComplete;
        await settleTasks();

        expect(request.mock.calls.filter(([method]) => method === "desktop.release")).toEqual([
          ["desktop.release", { wsPath: observed.wsPath }],
        ]);
        result.resolve(handle);
        await settleTasks();
        expect(handle.disconnect).toHaveBeenCalledOnce();
        panel.remove();
        expect(request.mock.calls.filter(([method]) => method === "desktop.release")).toHaveLength(
          1,
        );
      } finally {
        result.resolve(handle);
        panel.remove();
        await settleTasks();
      }
    },
  );

  it("keeps an authenticated viewer across a short hide without abandoning its observation", async () => {
    const handle = createConnectionHandle();
    const request = desktopRequests(observed);
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return handle;
    });
    const panel = await openPanel(request, connect);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    await settleTasks();
    panel.presented = false;
    await panel.updateComplete;
    expect(handle.disconnect).not.toHaveBeenCalled();
    panel.presented = true;
    await panel.updateComplete;
    await settleTasks();
    expect(connect).toHaveBeenCalledOnce();
    panel.remove();
    expect(handle.disconnect).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "desktop.release")).toBe(false);
  });
});
