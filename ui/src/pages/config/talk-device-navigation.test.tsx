/* @vitest-environment jsdom */

import { createRouter } from "@openclaw/uirouter";
import { expect, it, vi } from "vitest";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import type { ConfigPageId, ConfigPageRouteData } from "./config-page.tsx";
import { pages } from "./route.ts";

it("leaves Talk while an admitted native language edit is held", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const post = vi.fn<(message: unknown) => Promise<unknown>>().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", {
    messageHandlers: { openclawDeviceSettings: { postMessage: post } },
  });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const capability = createNativeDeviceSettingsCapability()!;
  const held = Promise.withResolvers<unknown>();
  post.mockReturnValueOnce(held.promise);
  const { gateway } = createApplicationGateway();
  // SAFETY: completeConfigContext fills unrelated capabilities for this route fixture.
  const context = completeConfigContext({
    gateway,
    nativeDeviceSettings: capability,
  } as unknown as ApplicationContext);
  Object.assign(context.runtimeConfig.state, {
    configSchema: {
      type: "object",
      properties: {
        broadcast: { type: "object", properties: { strategy: { type: "string" } } },
      },
    },
    configForm: { broadcast: { strategy: "sequential" } },
  });
  const provider = createSolidApplicationContextProvider(context);
  const routes = pages.filter(
    (page): page is Extract<(typeof pages)[number], { id: ConfigPageId }> =>
      page.id === "talk" || page.id === "advanced",
  );
  const production = await routes[0]!.component();
  const Page = production.renderSolid;
  const module = {
    ...production,
    renderSolid: (props: SolidRouteProps<ConfigPageRouteData>) => (
      <provider.wrapper>
        <Page {...props} />
      </provider.wrapper>
    ),
  };
  const router = createRouter<ConfigPageId, ApplicationContext, typeof module, ConfigPageRouteData>(
    {
      routes: routes.map((route) => Object.assign({}, route, { component: () => module })),
    },
  );
  Object.assign(context, { router });
  const view = mountRouterOutlet({ router, retryContext: context });
  const accepted = createNativeDeviceSettingsSnapshot();
  accepted.voice.locale.primary = "de-DE";
  const language = 'select[aria-label="Primary language"]';
  const expectAdvanced = () => {
    expect(view.querySelector(".content-header--settings .page-title")?.textContent).toBe(
      "Advanced",
    );
    expect(view.querySelector<HTMLInputElement>("#config-section-broadcast input")?.value).toBe(
      "sequential",
    );
    expect(view.querySelector("openclaw-talk-settings")).toBeNull();
    expect(view.querySelector(language)).toBeNull();
  };
  try {
    await router.navigate("talk", context);
    const select = await waitForSolid(() => {
      const control = view.querySelector<HTMLSelectElement>(language);
      expect(control).not.toBeNull();
      return control!;
    });
    select.value = "de-DE";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForSolid(() =>
      expect(post).toHaveBeenLastCalledWith({
        type: "set",
        key: "voice.locale.primary",
        value: "de-DE",
      }),
    );
    const navigation = router.navigate("advanced", context);
    await waitForSolid(expectAdvanced);
    await navigation;
    expect(capability.snapshot?.voice.locale?.primary).toBe("en-US");
    held.resolve(accepted);
    await waitForSolid(() => expect(capability.snapshot?.voice.locale?.primary).toBe("de-DE"));
    expectAdvanced();
  } finally {
    held.resolve(accepted);
    view.dispose();
    router.stop();
    capability.dispose();
    vi.unstubAllGlobals();
  }
});
