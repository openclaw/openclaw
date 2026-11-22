import { beforeEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context-types.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createChromeExtensionSetupResult } from "../../test-helpers/chrome-extension-setup.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { AppsPage } from "./apps-page.tsx";
import { Apps } from "./view.tsx";
import "../../styles.css";

it.each([false, true])(
  "keeps catalog actions with their cards (native setup: %s)",
  async (native) => {
    const { page } = await import("vitest/browser");
    const viewport = { width: innerWidth, height: innerHeight };
    await page.viewport(820, 1180);
    if (native) {
      const snapshot = createNativeDeviceSettingsSnapshot();
      vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
      vi.stubGlobal("webkit", {
        messageHandlers: {
          openclawDeviceSettings: {
            postMessage: async ({ type }: { type: string }) =>
              type === "chrome-extension-setup" ? createChromeExtensionSetupResult() : snapshot,
          },
        },
      });
    }
    const nativeDeviceSettings = native ? createNativeDeviceSettingsCapability() : null;
    const { wrapper } = createSolidApplicationContextProvider({
      nativeDeviceSettings,
    } as ApplicationContext);
    const mounted = mountSolid(() => <Apps onNavigate={() => undefined} />, { wrapper });
    try {
      const chromeLink = mounted.getByRole("link", { name: "Chrome Web Store" });
      const pluginsButton = mounted.getByRole("button", { name: "Open plugins" });
      const chrome = chromeLink.closest("article")!;
      const plugins = pluginsButton.closest("article")!;
      expect(chrome.getBoundingClientRect().top).toBe(plugins.getBoundingClientRect().top);
      if (native) {
        const chromeHeight = chrome.getBoundingClientRect().height;
        const pluginsHeight = plugins.getBoundingClientRect().height;
        mounted.getByRole("button", { name: "Refresh setup status" }).click();
        await waitForSolid(() =>
          expect(chrome.getBoundingClientRect().height).toBeGreaterThan(chromeHeight),
        );
        expect(plugins.getBoundingClientRect().height).toBe(pluginsHeight);
        expect(pluginsHeight).toBeLessThan(chromeHeight);
      } else {
        expect(chromeLink.getBoundingClientRect().top).toBe(
          pluginsButton.getBoundingClientRect().top,
        );
      }
    } finally {
      mounted.unmount();
      nativeDeviceSettings?.dispose();
      vi.unstubAllGlobals();
      await page.viewport(viewport.width, viewport.height);
    }
  },
);

beforeEach(async () => {
  await i18n.setLocale("en");
});

it.each([
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
])("shows companion apps without a duplicate plugin catalog on $name", async (size) => {
  const { page } = await import("vitest/browser");
  const initialViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(size.width, size.height);
  const { gateway, publish } = createApplicationGateway();
  const request = createGatewayRequestMock(async () => ({ servers: [] }));
  const describe = vi.fn(async () => ({ session: { key: "agent:main:catalog" } }));
  publish({
    ...gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    sessionKey: "agent:main:catalog",
    hello: gatewayHelloForMethods(["mcp.app.discover"]),
  });
  // MCP Apps are available, but the companion-app directory does not discover them.
  const context = {
    gateway,
    navigate: () => undefined,
    agentSelection: {
      state: { selectedId: "main" },
      subscribe: () => () => undefined,
    },
    sessions: { describe },
  } as unknown as ApplicationContext;
  const mounted = mountSolid(
    () => (
      <main class="content content--hub-header">
        <AppsPage />
      </main>
    ),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  try {
    await vi.dynamicImportSettled();
    await waitForSolid(() =>
      expect(mounted.getByRole("heading", { name: "Take OpenClaw everywhere" })).toBeVisible(),
    );
    expect(mounted.queryByRole("heading", { name: "Plugin apps" })).toBeNull();
    expect(mounted.queryByRole("button", { name: "Configure MCP servers" })).toBeNull();
    expect(mounted.getByRole("heading", { name: "iPhone" })).toBeVisible();
    const intro = mounted.getByText(/Companion apps for phone/);
    const section = mounted.getByRole("heading", { name: "On your phone" });
    expect(section.getBoundingClientRect().left).toBeCloseTo(intro.getBoundingClientRect().left, 0);
    expect(describe).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  } finally {
    mounted.unmount();
    window.scrollTo(0, 0);
    await page.viewport(initialViewport.width, initialViewport.height);
  }
});
