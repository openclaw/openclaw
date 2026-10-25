import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_PREFERENCE,
  type BackgroundPreference,
} from "../../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { UsersBackgroundResult } from "../../../../packages/gateway-protocol/src/schema/users-background.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import {
  rememberProfileAppearanceIdentity,
  resetProfileAppearancePrefs,
} from "../../app/server-prefs-profile.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import type { SessionBackground } from "../../components/session-background-host.tsx";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { AppearanceBackground } from "./appearance-background.tsx";
import { createConfigRouteContext } from "./config-page.test-support.ts";
import "../../styles.css";
import "../../styles/config.css";
import "../../styles/settings.css";

let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  host = document.createElement("div");
  host.className = "content";
  host.style.cssText = "position: fixed; inset: 24px 32px; overflow: auto;";
  document.body.append(host);
});
afterEach(() => {
  host.remove();
  resetProfileAppearancePrefs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(
  preference: Partial<BackgroundPreference> = {},
  client?: GatewayBrowserClient,
) {
  const gateway = createApplicationGateway();
  if (client) {
    vi.spyOn(client, "connected", "get").mockReturnValue(true);
    rememberProfileAppearanceIdentity(gateway.gateway.connection.gatewayUrl, "background-demo");
    gateway.publish({
      ...gateway.gateway.snapshot,
      client,
      phase: "connected",
      selfUser: { id: "background-demo" },
    });
  }
  const settings = patchSettings({
    gatewayUrl: gateway.gateway.connection.gatewayUrl,
    themeMode: "dark",
    background: { ...DEFAULT_BACKGROUND_PREFERENCE, ...preference },
  });
  const theme = createApplicationTheme(settings, gateway.gateway);
  onTestFinished(() => theme.dispose());
  const backgroundModule = { renderSolid: AppearanceBackground };
  const router = createRouter<RouteId, ApplicationContext, typeof backgroundModule>({
    routes: [
      definePage({
        id: "appearance",
        path: "/settings/appearance",
        component: () => backgroundModule,
      }),
      definePage({
        id: "usage",
        path: "/usage",
        component: () => ({ renderSolid: () => <p>Background destination</p> }),
      }),
    ],
  });
  const applicationFixture = createConfigRouteContext();
  const context: ApplicationContext = {
    ...applicationFixture,
    gateway: gateway.gateway,
    runtimeConfig: {
      ...applicationFixture.runtimeConfig,
      state: { ...applicationFixture.runtimeConfig.state, connected: true },
      canPatch: true,
    },
    theme,
    router,
  };
  const provider = createSolidApplicationContextProvider(context);
  host.innerHTML = '<div class="config-content"><div class="settings-page"></div></div>';
  const container = host.querySelector<HTMLElement>(".settings-page")!;
  const { unmount: dispose } = mountSolid(
    () => <RouterOutlet router={router} retryContext={context} />,
    {
      container,
      wrapper: provider.wrapper,
    },
  );
  await router.navigate("appearance", context);
  await waitForSolid(() => {
    expect(container.querySelector("openclaw-appearance-background")).not.toBeNull();
  });
  const element = container.querySelector<HTMLElement>("openclaw-appearance-background")!;
  const range = element.querySelector<HTMLInputElement>('input[type="range"]')!;
  const preview = element.querySelector<SessionBackground>("[data-background-preview-canvas]")!;
  await preview.updateComplete;
  return {
    element,
    range,
    preview,
    gateway,
    context,
    navigate: () => void router.navigate("usage", context),
    leavePage: () => router.navigate("usage", context),
    dispose: () => {
      dispose();
      router.stop();
    },
    setContext: (next: ApplicationContext) => {
      provider.setContext(next);
      flush();
    },
  };
}

function press(range: HTMLInputElement, type = "pointerdown") {
  range.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, bubbles: true }),
  );
}

function key(range: HTMLInputElement, value: string) {
  range.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
}

function activate(range: HTMLInputElement, gesture: "drag" | "Home" | "ArrowRight" = "ArrowRight") {
  if (gesture === "drag") {
    press(range);
  } else {
    key(range, gesture);
  }
  flush();
}

type Preview = Awaited<ReturnType<typeof mount>>;
const disabledPlacement = { showOnNewSession: false, showInSessions: false };
const savedBackground = { status: "ok", asset: null, preference: null } as const;
function uploadControls(element: HTMLElement) {
  return {
    input: element.querySelector<HTMLInputElement>("[data-background-file]")!,
    upload: element.querySelector<HTMLButtonElement>("[data-background-upload]")!,
  };
}

function expectMessage(element: HTMLElement, role: "alert" | "status", text?: string) {
  const message = element.querySelector(`[role="${role}"]`);
  if (text === undefined) {
    expect(message).toBeNull();
  } else {
    expect(message?.textContent).toContain(text);
  }
}

function waitUpload(
  element: HTMLElement,
  upload: HTMLButtonElement,
  disabled: boolean,
  status: string | undefined,
  alert?: string | null,
) {
  return waitForSolid(() => {
    expect(upload.disabled).toBe(disabled);
    if (status !== undefined) {
      expectMessage(element, "status", status);
    }
    if (alert !== undefined) {
      expectMessage(element, "alert", alert ?? undefined);
    }
  });
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
it("holds during a drag, settles 1.2 seconds after release, and keeps focused controls opaque", async () => {
  const preference = { ...disabledPlacement, presentation: "full-bleed" } as const;
  const { element, range, preview } = await mount(preference);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  range.focus();
  const before = range.getBoundingClientRect();
  activate(range, "drag");
  await preview.updateComplete;
  expect(element.hasAttribute("data-background-preview")).toBe(true);
  expect(host.hasAttribute("data-background-preview")).toBe(true);
  expect(document.activeElement).toBe(range);
  expect(range.disabled).toBe(false);
  expect(range.getBoundingClientRect().toJSON()).toEqual(before.toJSON());
  expect(getComputedStyle(preview)).toMatchObject({
    pointerEvents: "none",
    position: "fixed",
    transitionDuration: "0s",
    animationName: "none",
  });
  const groupStyle = getComputedStyle(element.querySelector(".settings-group")!);
  expect(groupStyle.opacity).toBe("1");
  expect(groupStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  const canvas = host.getBoundingClientRect();
  expect(preview.getBoundingClientRect()).toMatchObject({
    top: canvas.top,
    left: canvas.left,
    width: host.clientWidth,
    height: host.clientHeight,
  });
  await vi.advanceTimersByTimeAsync(2500);
  expect(preview.presented).toBe(true);
  press(range, "pointerup");
  await vi.advanceTimersByTimeAsync(1199);
  expect(preview.presented).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  flush();
  expect(preview.presented).toBe(false);
  expect(element.hasAttribute("data-background-preview")).toBe(false);
  expect(host.hasAttribute("data-background-preview")).toBe(false);
  expect(element.style.getPropertyValue("--settings-background-preview-width")).toBe("");
  expect(document.activeElement).toBe(range);
});

it("shows keyboard changes without focus activation and resets the brief settle period", async () => {
  const { range, preview } = await mount();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  range.focus();
  expect(preview.presented).toBe(false);
  activate(range);
  expect(preview.presented).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  key(range, "End");
  await vi.advanceTimersByTimeAsync(1000);
  expect(preview.presented).toBe(true);
  await vi.advanceTimersByTimeAsync(200);
  flush();
  expect(preview.presented).toBe(false);
  expect(document.activeElement).toBe(range);
});

it.each(["drag", "same-turn keyboard"])("reopens after Escape from %s", async (gesture) => {
  const { range, preview } = await mount();
  activate(range, gesture === "drag" ? "drag" : "ArrowRight");
  key(range, "Escape");
  expect(preview.presented).toBe(false);
  if (gesture === "drag") {
    range.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(preview.presented).toBe(false);
    press(range, "pointerup");
  }
  key(range, "ArrowLeft");
  flush();
  expect(preview.presented).toBe(true);
});

it.each([
  ["blur", ({ range }) => range.blur()],
  ["window-blur", () => window.dispatchEvent(new Event("blur"))],
  ["pointercancel", ({ range }) => press(range, "pointercancel")],
  ["navigation", ({ navigate }) => navigate()],
  ["disconnect", ({ dispose }) => dispose()],
  [
    "profile replacement",
    ({ gateway }) =>
      gateway.publish({ ...gateway.gateway.snapshot, selfUser: { id: "next-profile" } }),
  ],
  ["context replacement", ({ context, setContext }) => setContext({ ...context })],
] satisfies Array<[string, (view: Preview) => void]>)(
  "retires the canvas on %s without leaving a delayed preview",
  async (reason, retire) => {
    const view = await mount();
    const { element, range, preview } = view;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    range.focus();
    activate(range, reason === "profile replacement" ? "drag" : "Home");
    expect(preview.presented).toBe(true);
    retire(view);
    expect(preview.presented).toBe(false);
    expect(element.hasAttribute("data-background-preview")).toBe(false);
    flush();
    expect(preview.presented).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(preview.presented).toBe(false);
  },
);

it("passes live preferences to the shared renderer without enabling disabled placement", async () => {
  const { range, preview } = await mount({ ...disabledPlacement, visibility: 0 });
  activate(range);
  await preview.updateComplete;
  expect(preview.preferenceOverride?.visibility).toBe(0);
  expect(preview.querySelector(".session-background__image")).toBeNull();
  patchSettings({
    background: { ...DEFAULT_BACKGROUND_PREFERENCE, ...loadSettings().background, visibility: 0.8 },
  });
  flush();
  await preview.updateComplete;
  expect(preview.preferenceOverride).toMatchObject({ ...disabledPlacement, visibility: 0.8 });
  expect(range.getAttribute("aria-valuetext")).toBe("80%");
  await waitForSolid(() => {
    expect(preview.querySelector(".session-background__image")).not.toBeNull();
  });
  patchSettings({
    background: {
      ...DEFAULT_BACKGROUND_PREFERENCE,
      ...loadSettings().background,
      source: { kind: "none" },
    },
  });
  flush();
  expect(preview.presented).toBe(false);
});

function chooseBackgroundFile(input: HTMLInputElement) {
  const transfer = new DataTransfer();
  transfer.items.add(new File(["synthetic image"], "background.png", { type: "image/png" }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

it("leaves the background page while an upload is still pending", async () => {
  const pending = createDeferred<UsersBackgroundResult>();
  const saved = savedBackground;
  const request = vi.fn((method: string) =>
    method === "users.background.upload" ? pending.promise : Promise.resolve(saved),
  );
  const { element, leavePage, dispose } = await mount({}, createTestGatewayClient(request));
  chooseBackgroundFile(element.querySelector<HTMLInputElement>("[data-background-file]")!);
  await waitForSolid(() => {
    expect(request.mock.calls.some(([method]) => method === "users.background.upload")).toBe(true);
    expectMessage(element, "status", "Preparing");
  });
  let navigation: ReturnType<typeof leavePage> | undefined;
  try {
    navigation = leavePage();
    await waitForSolid(() => {
      expect(host.textContent).toContain("Background destination");
      expect(element.isConnected).toBe(false);
    });
    pending.resolve(saved);
    await navigation;
    await waitForSolid(() => {
      expect(host.textContent).toContain("Background destination");
      expect(host.querySelector("openclaw-appearance-background")).toBeNull();
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  } finally {
    pending.resolve(saved);
    await navigation;
    dispose();
  }
});

it("presents background upload failure and retry without losing the selected controls", async () => {
  const first = createDeferred<UsersBackgroundResult>();
  const second = createDeferred<UsersBackgroundResult>();
  let uploads = 0;
  let failMetadata = false;
  const request = vi.fn((method: string) => {
    if (method === "users.background.upload") {
      return uploads++ === 0 ? first.promise : second.promise;
    }
    if (failMetadata && method === "users.background.get") {
      return Promise.reject(new Error("Synthetic metadata failure after saving"));
    }
    return Promise.resolve(savedBackground);
  });
  const { element, gateway } = await mount({}, createTestGatewayClient(request));
  const { input, upload } = uploadControls(element);
  chooseBackgroundFile(input);
  await waitUpload(element, upload, true, "Preparing your image");
  first.reject(new Error("Synthetic upload failure"));
  await waitUpload(element, upload, false, undefined, "Synthetic upload failure");
  chooseBackgroundFile(input);
  await waitUpload(element, upload, true, "Preparing your image", null);
  second.resolve(savedBackground);
  await waitUpload(element, upload, false, "Background image saved.", null);
  expect(element.querySelector("[data-background-file]")).toBe(input);
  failMetadata = true;
  gateway.publishEvent({
    type: "event",
    event: "users.prefs.changed",
    payload: { keys: ["ui.background"] },
  });
  await waitForSolid(() => {
    expectMessage(element, "alert", "Synthetic metadata failure after saving");
    expectMessage(element, "status");
  });
});

it.each(["retired upload", "pending metadata"] as const)(
  "preserves replacement-profile upload ownership with %s",
  async (scenario) => {
    const retired = scenario === "retired upload";
    const first = createDeferred<UsersBackgroundResult>();
    const second = createDeferred<UsersBackgroundResult>();
    const metadata = createDeferred<UsersBackgroundResult>();
    let uploads = 0;
    let holdMetadata = false;
    const request = vi.fn(
      (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "users.background.get" && options?.signal && holdMetadata) {
          return metadata.promise;
        }
        if (method === "users.background.upload") {
          return uploads++ === 0 ? first.promise : second.promise;
        }
        return Promise.resolve(savedBackground);
      },
    );
    const { element, gateway } = await mount({}, createTestGatewayClient(request));
    const { input, upload } = uploadControls(element);
    chooseBackgroundFile(input);
    await waitForSolid(() => expect(uploads).toBe(1));
    if (!retired) {
      first.reject(new Error("Previous profile's upload failed"));
      await waitForSolid(() => expectMessage(element, "alert", "Previous profile's upload failed"));
      holdMetadata = true;
    }
    gateway.publish({ ...gateway.gateway.snapshot, selfUser: { id: "replacement-demo" } });
    await waitForSolid(() => expect(upload.disabled).toBe(false));
    await waitForSolid(() => expectMessage(element, "alert"));
    if (retired) {
      second.resolve(savedBackground);
    }
    chooseBackgroundFile(input);
    await waitForSolid(() => expect(uploads).toBe(2));
    if (retired) {
      await waitUpload(element, upload, false, "Background image saved.");
      first.reject(new Error("Retired upload failure"));
      await waitForSolid(() => expectMessage(element, "alert"));
      chooseBackgroundFile(input);
      await waitForSolid(() => expect(uploads).toBe(3));
    } else {
      await waitForSolid(() => expect(upload.disabled).toBe(true));
      gateway.publish({
        ...gateway.gateway.snapshot,
        selfUser: { id: "replacement-demo", name: "Updated display name" },
      });
      await nextFrame();
      flush();
      expect(upload.disabled).toBe(true);
      expectMessage(element, "status", "Preparing your image");
      second.resolve(savedBackground);
      await waitUpload(element, upload, false, "Background image saved.");
      metadata.resolve(savedBackground);
    }
  },
);

it("shows invalid background file feedback and clears it when a valid upload starts", async () => {
  const metadata = createDeferred<UsersBackgroundResult>();
  const completion = createDeferred<UsersBackgroundResult>();
  const saved = savedBackground;
  const request = vi.fn((method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
    if (method === "users.background.get" && options?.signal) {
      return metadata.promise;
    }
    return method === "users.background.upload" ? completion.promise : Promise.resolve(saved);
  });
  const { element } = await mount({}, createTestGatewayClient(request));
  const { input, upload } = uploadControls(element);
  metadata.reject(new Error("Synthetic metadata failure before upload"));
  await waitForSolid(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic metadata failure before upload",
    ),
  );
  const transfer = new DataTransfer();
  transfer.items.add(new File(["invalid image"], "background.txt", { type: "text/plain" }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await waitForSolid(() => {
    expectMessage(
      element,
      "alert",
      "Choose a JPEG, PNG, or WebP image within the upload size limit.",
    );
    expect(upload.disabled).toBe(false);
  });
  chooseBackgroundFile(input);
  await waitUpload(element, upload, true, "Preparing your image", null);
  completion.resolve(saved);
  await waitUpload(element, upload, false, "Background image saved.", null);
});

it("dismisses metadata errors on a local choice and retires reads across profiles", async () => {
  const first = createDeferred<UsersBackgroundResult>();
  const abandoned = createDeferred<UsersBackgroundResult>();
  let reads = 0;
  const request = vi.fn(() => {
    reads += 1;
    return reads === 1
      ? first.promise
      : reads === 2
        ? abandoned.promise
        : Promise.resolve(savedBackground);
  });
  const { element, gateway, range } = await mount(
    { source: { kind: "custom", assetId: "metadata-old" } },
    createTestGatewayClient(request),
  );
  await waitForSolid(() => expect(reads).toBe(1));
  first.reject(new Error("Synthetic metadata failure"));
  await waitForSolid(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Synthetic metadata failure",
    ),
  );
  element.querySelector<HTMLButtonElement>('[data-background-source="theme"]')!.click();
  await waitForSolid(() => {
    expect(reads).toBe(2);
    expectMessage(element, "alert");
  });
  gateway.publish({ ...gateway.gateway.snapshot, selfUser: { id: "replacement-demo" } });
  patchSettings({
    background: { ...DEFAULT_BACKGROUND_PREFERENCE, ...loadSettings().background, visibility: 0.8 },
  });
  await waitForSolid(() => {
    expect(reads).toBe(3);
    expect(range.getAttribute("aria-valuetext")).toBe("80%");
    expectMessage(element, "alert");
  });
  abandoned.reject(new Error("Retired metadata failure"));
  await nextFrame();
  await waitForSolid(() => expectMessage(element, "alert"));
  expect(element.querySelector('input[type="range"]')).toBe(range);
});

it("recovers thumbnail errors without waiting for a retired image and revokes the current URL", async () => {
  const first = createDeferred<Response>();
  const abandoned = createDeferred<Response>();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const jpeg = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg");
  });
  expect(jpeg).not.toBeNull();
  let imageReads = 0;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!url.pathname.includes("/__openclaw__/users/background/")) {
      return nativeFetch(input, init);
    }
    imageReads += 1;
    return imageReads === 1
      ? first.promise
      : imageReads === 2
        ? abandoned.promise
        : Promise.resolve(new Response(jpeg, { headers: { "content-type": "image/jpeg" } }));
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const request = vi.fn(async () => ({
    status: "ok",
    preference: null,
    asset: {
      assetId: "thumbnail-demo",
      width: 2,
      height: 2,
      mime: "image/jpeg",
      byteLength: jpeg!.size,
    },
  }));
  const { element, gateway } = await mount({}, createTestGatewayClient(request));
  await waitForSolid(() => expect(imageReads).toBe(1));
  first.reject(new Error("Synthetic thumbnail failure"));
  await waitForSolid(() =>
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Your background image could not be loaded",
    ),
  );
  element.querySelector<HTMLButtonElement>('[data-background-source="theme"]')!.click();
  await waitForSolid(() => expectMessage(element, "alert"));
  const refresh = () =>
    gateway.publishEvent({
      type: "event",
      event: "users.prefs.changed",
      payload: { keys: ["ui.background"] },
    });
  refresh();
  await waitForSolid(() => expect(imageReads).toBe(2));
  refresh();
  await waitForSolid(() => {
    expect(imageReads).toBe(3);
    expect(
      element.querySelector<HTMLImageElement>(".settings-background-option__sample img")?.src,
    ).toMatch(/^blob:/);
    expectMessage(element, "alert");
  });
  const currentUrl = element.querySelector<HTMLImageElement>(
    ".settings-background-option__sample img",
  )!.src;
  abandoned.reject(new Error("Retired thumbnail failure"));
  await nextFrame();
  await waitForSolid(() => {
    expectMessage(element, "alert");
    expect(
      element.querySelector<HTMLImageElement>(".settings-background-option__sample img")?.src,
    ).toBe(currentUrl);
  });
  gateway.publish({ ...gateway.gateway.snapshot, phase: "stopped", client: null });
  await waitForSolid(() =>
    expect(element.querySelector(".settings-background-option__sample img")).toBeNull(),
  );
  expect(revoke).toHaveBeenCalledWith(currentUrl);
});
