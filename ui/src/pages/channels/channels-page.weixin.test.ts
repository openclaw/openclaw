import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createConfigServerMock } from "../../lib/config/config-test-harness.ts";
import {
  createContext,
  createGateway,
  type ChannelsPageTestElement,
} from "./channels-page.test-support.ts";
import "./channels-page.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ChannelsPage Weixin lifecycle", () => {
  async function mountWeixin(
    options: { restartRequired?: boolean; enable?: Promise<unknown>; refreshFails?: boolean } = {},
  ) {
    const gateway = createGateway();
    gateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const source = createContext(gateway);
    const store = createConfigServerMock();
    let enabled = false;
    const entry = () => ({
      id: "openclaw-weixin",
      name: "Weixin",
      installed: true,
      enabled,
      state: enabled ? "enabled" : "disabled",
      hasIcon: false,
    });
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const base = request.getMockImplementation();
    request.mockImplementation(async (method, params) => {
      if (method === "plugins.list") {
        return { plugins: [entry()], diagnostics: [], mutationAllowed: true };
      }
      if (method === "plugins.setEnabled") {
        if (options.enable) {
          await options.enable;
        }
        enabled = true;
        return { ok: true, plugin: entry(), restartRequired: options.restartRequired ?? false };
      }
      if (method.startsWith("config.")) {
        if (enabled && options.refreshFails) {
          throw new Error("Config refresh failed");
        }
        return store.request(method, params);
      }
      return base?.(method, params);
    });
    const page = document.createElement("openclaw-channels-page") as ChannelsPageTestElement;
    page.context = source.context;
    document.body.append(page);
    await vi.waitFor(() =>
      expect(page.querySelector(".weixin-login button")?.textContent).toContain(
        "Enable and connect",
      ),
    );
    return { gateway, source, page, request };
  }

  it.each([true, false])(
    "opens unconfigured Weixin details for an administrator=%s",
    async (admin) => {
      const { source, page, gateway } = await mountWeixin();
      source.channels.state.channelsSnapshot = {
        ts: 0,
        channelOrder: ["openclaw-weixin"],
        channelLabels: {},
        channels: { "openclaw-weixin": { configured: false, running: false } },
        channelAccounts: {},
        channelDefaultAccountId: {},
      };
      gateway.emit({
        hello: {
          auth: {
            role: "operator",
            scopes: admin ? ["operator.admin", "operator.read"] : ["operator.read"],
          },
        } as ApplicationGatewaySnapshot["hello"],
      });
      page.requestUpdate();
      await page.updateComplete;
      const start = vi.spyOn(source.channels, "startWeixin").mockResolvedValue();
      const details = [...page.querySelectorAll<HTMLButtonElement>(".weixin-login button")].find(
        (button) => button.textContent?.includes("Open details"),
      );
      expect(details).toBeDefined();
      details!.click();
      await page.updateComplete;
      expect(page.querySelector(".channels-detail")).not.toBeNull();
      expect(start).not.toHaveBeenCalled();
      page.remove();
      source.runtimeConfig.dispose();
      source.channels.dispose();
    },
  );

  it.each([false, true])(
    "enables Weixin through the native receipt (restart required: %s)",
    async (restartRequired) => {
      const { source, page, request } = await mountWeixin({ restartRequired });
      const start = vi.spyOn(source.channels, "startWeixin").mockResolvedValue();
      page.querySelector<HTMLButtonElement>(".weixin-login button")!.click();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("plugins.setEnabled", {
          pluginId: "openclaw-weixin",
          enabled: true,
        }),
      );
      await vi.waitFor(() => {
        if (restartRequired) {
          expect(page.textContent).toContain("Restart the Gateway");
          expect(start).not.toHaveBeenCalled();
          expect(page.querySelector<HTMLButtonElement>(".weixin-login button")!.disabled).toBe(
            true,
          );
        } else {
          expect(start).toHaveBeenCalledOnce();
        }
      });
      page.remove();
      source.runtimeConfig.dispose();
      source.channels.dispose();
    },
  );

  it("shows post-enable config refresh failure without beginning login", async () => {
    const { source, page } = await mountWeixin({ refreshFails: true });
    const start = vi.spyOn(source.channels, "startWeixin").mockResolvedValue();
    page.querySelector<HTMLButtonElement>(".weixin-login button")!.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Config refresh failed"));
    expect(start).not.toHaveBeenCalled();
    page.remove();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("does not start login after an enable receipt arrives on an unmounted page", async () => {
    const enable = createDeferred<unknown>();
    const { source, page, request } = await mountWeixin({ enable: enable.promise });
    const start = vi.spyOn(source.channels, "startWeixin").mockResolvedValue();
    page.querySelector<HTMLButtonElement>(".weixin-login button")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("plugins.setEnabled", expect.any(Object)),
    );
    page.remove();
    enable.resolve({});
    await source.runtimeConfig.waitForPendingWrites();
    expect(start).not.toHaveBeenCalled();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("closes the former Channels login when its context changes on the same live gateway", async () => {
    const { source, page, gateway } = await mountWeixin();
    const close = vi.spyOn(source.channels, "closeWeixin");
    const second = createContext(gateway);
    page.context = second.context;
    page.requestUpdate();
    await page.updateComplete;
    expect(close).toHaveBeenCalledOnce();
    page.remove();
    for (const owner of [source, second]) {
      owner.runtimeConfig.dispose();
      owner.channels.dispose();
    }
  });
});
