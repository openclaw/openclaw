/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { DesktopClient } from "./desktop-client.ts";
import {
  clickPanelButton,
  createConnectionHandle,
  createGatewayClient,
  createPanel,
  desktopEnvironment,
} from "./desktop-panel.test-support.ts";

describe("session desktop connection", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("passes the worker observe password to the desktop client without an auth discriminator", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "environments.list") {
        return { environments: [desktopEnvironment] };
      }
      return {
        transport: "rfb",
        wsPath: "/desktop/observe?token=worker",
        expiresAtMs: 60_000,
        control: false,
        vncPassword: "synthetic-worker-password",
      };
    });
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.documentMode = true;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() =>
      expect(panel.renderRoot.querySelector(".desktop-environment button")).not.toBeNull(),
    );
    clickPanelButton(panel);
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(connect.mock.calls[0]?.[0].credentials).toEqual({
      password: "synthetic-worker-password",
    });
  });

  it("opens only the session desktop without waiting for global inventory and retries its status", async () => {
    const pending = createDeferred<typeof desktopEnvironment>();
    let environment = pending.promise;
    const request = vi.fn(async (method: string) => {
      if (method === "environments.status") {
        return environment;
      }
      if (method === "desktop.observe") {
        return {
          transport: "rfb",
          wsPath: "/desktop/observe?token=session",
          expiresAtMs: 60_000,
          control: false,
        };
      }
      throw new Error("Global inventory unavailable");
    });
    const connect = vi.fn(async (options: Parameters<DesktopClient["connect"]>[0]) => {
      options.onConnect?.();
      return createConnectionHandle();
    });
    const panel = createPanel();
    panel.client = createGatewayClient(request).client;
    panel.available = true;
    panel.embedded = true;
    panel.presented = true;
    panel.sessionKey = "agent:main:cloud";
    panel.requestedSource = desktopEnvironment.id;
    panel.desktopClientFactory = () => ({ connect });
    document.body.append(panel);

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("environments.status", {
        environmentId: desktopEnvironment.id,
      }),
    );
    expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
    expect(panel.renderRoot.querySelectorAll(".desktop-environment")).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();

    pending.reject(new Error("Desktop is still starting"));
    await waitForFast(() =>
      expect(panel.renderRoot.textContent).toContain("Desktop is still starting"),
    );
    expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
    environment = Promise.resolve(desktopEnvironment);
    clickPanelButton(panel, ".desktop-status button");
    await waitForFast(() => expect(connect).toHaveBeenCalledOnce());
    expect(request).toHaveBeenLastCalledWith("desktop.observe", {
      source: { kind: "environment", environmentId: desktopEnvironment.id },
      control: false,
    });
    expect(request.mock.calls.some(([method]) => method === "environments.list")).toBe(false);
    expect(panel.renderRoot.querySelector(".desktop-picker")).toBeNull();
  });
});
