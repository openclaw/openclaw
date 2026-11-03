import { createRouter } from "@openclaw/uirouter";
import { createSignal } from "solid-js";
import { expect, onTestFinished, vi } from "vitest";
import type { SolidRouteProps } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { mountRouterOutlet } from "../../app/router-outlet.test-support.tsx";
import type { SelectPicker } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { completeConfigContext } from "./config-page.test-support.ts";
import type { ConfigPageId, ConfigPageRouteData } from "./config-page.tsx";
import { pages } from "./route.ts";
import { TalkSettingsPage } from "./talk-page.tsx";

export type TalkPageElement = HTMLElement & {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  changeModel: (model: string | null) => void;
  changeProvider: (providerId: string | null) => void;
};

export function nativeVoice(snapshot: NonNullable<NativeDeviceSettingsCapability["snapshot"]>) {
  const listeners = new Set<() => void>();
  const settings = {
    snapshot,
    initialSnapshot: Promise.resolve(snapshot),
    set: vi.fn<NativeDeviceSettingsCapability["set"]>(),
    subscribe: (listener: Parameters<NativeDeviceSettingsCapability["subscribe"]>[0]) => {
      const notify = () => listener(snapshot);
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    requestPermission: vi.fn(),
    openSystemSettings: vi.fn(),
    openPanel: vi.fn(),
    checkForUpdates: vi.fn(),
    setupChromeExtension: vi.fn(),
    refresh: vi.fn(),
    dispose: vi.fn(),
  } satisfies NativeDeviceSettingsCapability;
  return {
    settings,
    publish: () => {
      listeners.forEach((notify) => notify());
      flush();
    },
  };
}

export function readVoiceOptions(page: HTMLElement): string[] {
  return [...page.querySelectorAll("select option")].map(
    (option) => option.getAttribute("value") ?? "",
  );
}

export function setTalkRealtimeConfig(page: TalkPageElement, realtime: Record<string, unknown>) {
  page.configObject = { talk: { realtime } };
}

export function expectVoiceState(page: TalkPageElement, options: string[], unsupported: boolean) {
  expect(readVoiceOptions(page)).toEqual(options);
  expect(page.textContent?.includes(t("talkPage.voice.unsupportedDefault"))).toBe(unsupported);
}

export function mountTalkPage(context: ApplicationContext, initialConfig: Record<string, unknown>) {
  const page: TalkPageElement = Object.assign(document.createElement("div"), {
    context,
    configObject: initialConfig,
    changeModel: (value: string | null) => {
      flush();
      const picker = page.querySelector<SelectPicker>("openclaw-select-picker");
      if (!picker) {
        throw new Error("Talk model picker is unavailable");
      }
      picker.params.onChange(value ?? "");
    },
    changeProvider: (value: string | null) => {
      const input = [...page.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (entry) => entry.value === (value ?? ""),
      );
      if (!input) {
        throw new Error("Talk provider choice is unavailable");
      }
      input.click();
    },
  });
  const [config, setConfig] = createSignal(initialConfig);
  document.body.append(page);
  const provider = createSolidApplicationContextProvider(context);
  const retired = new Promise<void>(() => {});
  const view = mountSolid(
    () => <TalkSettingsPage configObject={config()} presentationRetired={() => retired} />,
    { container: page, wrapper: provider.wrapper },
  );
  const remove = page.remove.bind(page);
  Object.defineProperties(page, {
    context: { value: context },
    configObject: { get: config, set: setConfig },
  });
  page.remove = () => {
    view.unmount();
    remove();
  };
  flush();
  return page;
}

export async function mountTalkSettingsRoutes(initialContext: ApplicationContext) {
  const context = completeConfigContext(initialContext);
  type SettingsRoute = Extract<(typeof pages)[number], { id: ConfigPageId }>;
  const routes = pages.filter(
    (route): route is SettingsRoute => route.id === "talk" || route.id === "notifications",
  );
  const productionModule = await routes[0]!.component();
  const Provider = createSolidApplicationContextProvider(context).wrapper;
  const ProductionRender = productionModule.renderSolid;
  const module = {
    ...productionModule,
    renderSolid: (props: SolidRouteProps<ConfigPageRouteData>) => (
      <Provider>
        <ProductionRender {...props} />
      </Provider>
    ),
  };
  const router = createRouter<ConfigPageId, ApplicationContext, typeof module, ConfigPageRouteData>(
    { routes: routes.map((route) => Object.assign({}, route, { component: () => module })) },
  );
  Object.assign(context, { router });
  const outlet = mountRouterOutlet({ router, retryContext: context });
  onTestFinished(async () => {
    outlet.dispose();
    router.stop();
    // The production route starts independent lazy siblings; finish their imports before teardown.
    await vi.dynamicImportSettled();
  });
  await router.navigate("talk", context);
  return {
    container: outlet,
    navigate: (pageId: "talk" | "notifications") => router.navigate(pageId, context),
  };
}
