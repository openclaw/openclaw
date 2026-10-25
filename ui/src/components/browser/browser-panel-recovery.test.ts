import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeBrowserMessage } from "../../app/native-browser-bridge.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./browser-panel.ts";
import { createBrowserClient } from "./browser-panel-controller-test-support.ts";

let originalFonts: PropertyDescriptor | undefined;

beforeEach(() => {
  originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
  });
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("ResizeObserver", undefined);
});

afterEach(() => {
  document.body.replaceChildren();
  restorePropertyDescriptor(document, "fonts", originalFonts);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountFailingBrowser(nativeAvailable: boolean, remoteAvailable: boolean) {
  const nativeMessages: NativeBrowserMessage[] = [];
  if (nativeAvailable) {
    vi.stubGlobal("webkit", {
      messageHandlers: {
        openclawBrowser: {
          postMessage: async (message: NativeBrowserMessage) => {
            nativeMessages.push(message);
            return message.type === "open"
              ? { ok: false, error: "Synthetic browser failure" }
              : { ok: true };
          },
        },
      },
    });
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 0, tabs: [] });
  }
  const { client, request } = createBrowserClient(async () => {
    throw new Error("Synthetic browser failure");
  });
  const panel = document.createElement("openclaw-browser-panel");
  panel.available = true;
  panel.remoteAvailable = remoteAvailable;
  panel.embedded = true;
  panel.presented = true;
  panel.client = client;
  const mounted = mountSolid(() => panel);
  const recovery = () => mounted.getByRole("button", { name: /^(Retry|Refresh)$/ });
  return { panel, mounted, recovery, request, nativeMessages };
}

it.each([false, true])(
  "retries a failed first native tab through native with remoteAvailable=%s",
  async (remoteAvailable) => {
    const { panel, mounted, recovery, request, nativeMessages } = mountFailingBrowser(
      true,
      remoteAvailable,
    );
    await panel.updateComplete;
    if (remoteAvailable) {
      await waitForSolid(() => expect(recovery()).toBeTruthy());
    }
    const address = mounted.getByRole("textbox", { name: "Page address" });
    Object.assign(address, { value: "https://example.test/first-native" });
    address.dispatchEvent(new Event("input", { bubbles: true }));
    address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitForSolid(() => {
      expect(nativeMessages.filter((message) => message.type === "open")).toHaveLength(1);
      expect(recovery()).toBeTruthy();
    });
    const remoteCalls = request.mock.calls.length;
    recovery().click();
    await waitForSolid(() => {
      expect(nativeMessages.filter((message) => message.type === "open")).toHaveLength(2);
      expect(recovery()).toBeTruthy();
    });
    expect(request).toHaveBeenCalledTimes(remoteCalls);
    for (const message of nativeMessages.filter((entry) => entry.type === "open")) {
      expect(message.url).toBe("https://example.test/first-native");
    }
    expect(panel.textContent).toContain("Synthetic browser failure");
    expect(panel.querySelector(".bp-shot")).toBeNull();
  },
);

it.each([false, true])(
  "retries remote inventory through remote with nativeAvailable=%s",
  async (nativeAvailable) => {
    const { panel, recovery, request, nativeMessages } = mountFailingBrowser(nativeAvailable, true);
    await waitForSolid(() => expect(recovery()).toBeTruthy());
    const remoteCalls = request.mock.calls.length;
    recovery().click();
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(remoteCalls + 1);
      expect(recovery()).toBeTruthy();
    });
    expect(request.mock.lastCall?.[1]).toMatchObject({ method: "GET", path: "/tabs" });
    expect(nativeMessages.filter((message) => message.type === "open")).toHaveLength(0);
    expect(panel.textContent).toContain("Synthetic browser failure");
    expect(panel.querySelector(".bp-shot")).toBeNull();
  },
);
