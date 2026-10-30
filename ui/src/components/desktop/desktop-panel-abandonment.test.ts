/* @vitest-environment jsdom */

import type { DesktopObserveResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { DesktopClient, DesktopConnectionHandle } from "./desktop-client.ts";
import * as desktop from "./desktop-panel.test-support.ts";

const observed: DesktopObserveResult = {
  transport: "rfb",
  wsPath: `/desktop/observe?token=${"a".repeat(48)}`,
  expiresAtMs: 60_000,
  control: false,
  preauthenticated: true,
};

function desktopRequests(result: DesktopObserveResult | Promise<DesktopObserveResult>) {
  return vi.fn(async (method: string, _params?: unknown) => {
    if (method === "desktop.observe") {
      return result;
    }
    if (method === "desktop.release") {
      return { released: true };
    }
    throw new Error(`Unexpected Desktop request: ${method}`);
  });
}

type Requests = ReturnType<typeof desktopRequests>;
const calls = (request: Requests, method: string) =>
  request.mock.calls.filter(([name]) => name === method);
function expectReleased(request: Requests, released = true) {
  expect(calls(request, "desktop.release")).toEqual(
    released ? [["desktop.release", { wsPath: observed.wsPath }]] : [],
  );
}

async function openPanel(request: Requests, connect: DesktopClient["connect"]) {
  const panel = Object.assign(desktop.createPanel(), {
    client: desktop.createGatewayClient(request).client,
    available: true,
    embedded: true,
    presented: true,
    suppliedEnvironments: [desktop.desktopEnvironment],
    desktopClientFactory: () => ({ connect }),
  });
  await desktop.mountPanel(panel);
  await panel.updateComplete;
  desktop.clickPanelButton(panel);
  await waitForSolid(() => expect(calls(request, "desktop.observe")).toHaveLength(1));
  return panel;
}

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(["hidden", "removed", "Gateway replaced"] as const)(
  "releases a late observe through its original client after the panel is %s",
  async (change) => {
    const observation = createDeferred<DesktopObserveResult>();
    const request = desktopRequests(observation.promise);
    const replacementRequest = desktopRequests(observed);
    const connect = vi.fn(async () => desktop.createConnectionHandle());
    const panel = await openPanel(request, connect);
    const originalClient = panel.client;
    if (change === "hidden") {
      panel.presented = false;
    } else if (change === "removed") {
      await desktop.unmountPanel(panel);
    } else {
      panel.client = desktop.createGatewayClient(replacementRequest).client;
    }
    await panel.updateComplete;
    observation.resolve(observed);
    await panel.updateComplete;

    await waitForSolid(() => expectReleased(request));
    expect(connect).not.toHaveBeenCalled();
    expectReleased(replacementRequest, false);
    expect(panel.isConnected).toBe(change !== "removed");
    if (change !== "Gateway replaced") {
      expect(panel.client).toBe(originalClient);
    }
  },
);

it.each(["credentials", "pending", "returned", "authenticated"] as const)(
  "abandons only unauthenticated observations when hidden at the %s stage",
  async (stage) => {
    const credentials = stage === "credentials";
    const authenticated = stage === "authenticated";
    const result = createDeferred<DesktopConnectionHandle>();
    const handle = desktop.createConnectionHandle();
    const request = desktopRequests(
      credentials ? { ...observed, auth: "vnc-password", preauthenticated: false } : observed,
    );
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      if (authenticated) {
        options.onConnect?.();
      }
      return authenticated || credentials ? handle : result.promise;
    });
    const panel = await openPanel(request, connect);
    try {
      await waitForSolid(() =>
        credentials
          ? expect(panel.querySelector(".desktop-credentials")).not.toBeNull()
          : expect(connect).toHaveBeenCalledOnce(),
      );
      if (stage === "returned") {
        result.resolve(handle);
        await connect.mock.results[0]!.value;
      }
      await panel.updateComplete;
      expectReleased(request, false);
      panel.presented = false;
      await panel.updateComplete;
      await panel.updateComplete;
      expectReleased(request, !authenticated);
      if (authenticated) {
        expect(handle.disconnect).not.toHaveBeenCalled();
        panel.presented = true;
      }
      result.resolve(handle);
      await connect.mock.results[0]?.value;
      await panel.updateComplete;
      expect(handle.disconnect).toHaveBeenCalledTimes(credentials || authenticated ? 0 : 1);
      expect(connect).toHaveBeenCalledTimes(credentials ? 0 : 1);
      await desktop.unmountPanel(panel);
      await panel.updateComplete;
      expectReleased(request, !authenticated);
      expect(handle.disconnect).toHaveBeenCalledTimes(credentials ? 0 : 1);
      expect(connect).toHaveBeenCalledTimes(credentials ? 0 : 1);
    } finally {
      result.resolve(handle);
      await desktop.unmountPanel(panel);
      await panel.updateComplete;
    }
  },
);
