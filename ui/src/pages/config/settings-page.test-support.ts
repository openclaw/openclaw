import { afterEach, expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";

const configs: RuntimeConfigCapability[] = [];

export function settingsButton(page: Element, label: string) {
  const button = [...page.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    [
      item.getAttribute("aria-label"),
      item.textContent?.trim(),
      item.querySelector(".settings-row__title")?.textContent?.trim(),
    ].includes(label),
  );
  if (!button) {
    throw new Error(`Missing button: ${label}`);
  }
  return button;
}

export function clickSettings(page: Element, label: string, assertEnabled = false) {
  const button = settingsButton(page, label);
  if (assertEnabled) {
    expect(button.disabled).toBe(false);
  }
  button.click();
  flush();
  return button;
}

export function waitSettingsText(page: Element, text: string, selector?: string) {
  return waitForSolid(() =>
    expect((selector ? page.querySelector(selector) : page)?.textContent).toContain(text),
  );
}

export async function mountConfigSettings(
  client: GatewayBrowserClient,
  render: Parameters<typeof mountSolid>[0],
) {
  const { gateway, publish } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  configs.push(runtimeConfig);
  await runtimeConfig.ensureLoaded();
  const navigate = vi.fn();
  const context = {
    gateway,
    runtimeConfig,
    navigate,
    basePath: "",
  } as unknown as ApplicationContext;
  const { container: page, unmount } = mountSolid(render, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  return { page, context, runtimeConfig, navigate, client, publish, unmount };
}

afterEach(() => {
  cleanupSolid();
  configs.splice(0).forEach((config) => config.dispose());
  vi.restoreAllMocks();
});
