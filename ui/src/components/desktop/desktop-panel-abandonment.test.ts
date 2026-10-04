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

  it.each(["credentials", "pending", "returned", "authenticated"] as const)(
    "abandons only unauthenticated observations when hidden at the %s stage",
    async (stage) => {
      const result = createDeferred<DesktopConnectionHandle>();
      const handle = createConnectionHandle();
      const request = desktopRequests(
        stage === "credentials"
          ? { ...observed, auth: "vnc-password", preauthenticated: false }
          : observed,
      );
      const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
        if (stage === "authenticated") {
          options.onConnect?.();
        }
        return stage === "authenticated" || stage === "credentials" ? handle : result.promise;
      });
      const panel = await openPanel(request, connect);
      try {
        if (stage === "credentials") {
          await waitForFast(() =>
            expect(panel.renderRoot.querySelector(".desktop-credentials")).not.toBeNull(),
          );
        } else {
          await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
          if (stage === "returned") {
            result.resolve(handle);
          }
          await settleTasks();
        }
        expect(request.mock.calls.some(([method]) => method === "desktop.release")).toBe(false);
        panel.presented = false;
        await panel.updateComplete;
        if (stage === "authenticated") {
          expect(handle.disconnect).not.toHaveBeenCalled();
          panel.presented = true;
          await panel.updateComplete;
          await settleTasks();
          expect(connect).toHaveBeenCalledOnce();
        } else {
          await settleTasks();
          expect(request.mock.calls.filter(([method]) => method === "desktop.release")).toEqual([
            ["desktop.release", { wsPath: observed.wsPath }],
          ]);
          result.resolve(handle);
          await settleTasks();
          if (stage !== "credentials") {
            expect(handle.disconnect).toHaveBeenCalledOnce();
          }
        }
        panel.remove();
        await settleTasks();
        if (stage === "authenticated") {
          expect(handle.disconnect).toHaveBeenCalledOnce();
          expect(request.mock.calls.some(([method]) => method === "desktop.release")).toBe(false);
        } else {
          expect(request.mock.calls.filter(([method]) => method === "desktop.release")).toEqual([
            ["desktop.release", { wsPath: observed.wsPath }],
          ]);
          if (stage === "credentials") {
            expect(connect).not.toHaveBeenCalled();
          }
        }
      } finally {
        result.resolve(handle);
        panel.remove();
        await settleTasks();
      }
    },
  );
});
