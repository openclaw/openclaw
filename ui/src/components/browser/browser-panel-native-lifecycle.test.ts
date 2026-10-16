import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { flushBrowserResponses } from "./browser-panel-controller-test-support.ts";
import {
  fakeNativeBrowser,
  mountSessionPanel,
  nativeTab,
  setupNativeBrowserPanelTests,
} from "./test-helpers/native-browser.ts";

const { controllerFixture, flushFrames } = setupNativeBrowserPanelTests();

describe("native Browser panel reply ownership", () => {
  it("retains a pre-mount native open and retires its subscription and replies on disposal", async () => {
    const native = fakeNativeBrowser();
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.remoteAvailable = false;
    panel.embedded = true;
    panel.presented = true;
    panel.handleToggleRequest(
      new CustomEvent("openclaw:browser-panel-toggle", {
        detail: { open: true, url: "https://example.test/before-mount", native: true },
      }),
    );
    await flushBrowserResponses();
    const mounted = mountSolid(() => panel);
    await panel.updateComplete;
    expect(panel.renderRoot.querySelector<HTMLInputElement>(".bp-url")?.value).toBe(
      "https://example.test/before-mount",
    );
    expect(panel.renderRoot.querySelectorAll('[role="tab"]')).toHaveLength(1);

    const reply = createDeferred<{ ok: true }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    panel.renderRoot.querySelector<HTMLButtonElement>('[aria-label="Reload"]')!.click();
    expect(native.messages().at(-1)).toMatchObject({ type: "reload" });
    const scope = panel.dataset.nativeBrowserScope;
    mounted.unmount();
    await waitForSolid(() =>
      expect(native.messages().at(-1)).toEqual({ type: "release-scope", scope }),
    );
    native.postMessage.mockClear();
    native.publish([nativeTab("mac-replacement")]);
    window.dispatchEvent(new Event("resize"));
    flushFrames();
    reply.reject(new Error("The disposed reload failed"));
    await flushBrowserResponses();
    expect(native.postMessage).not.toHaveBeenCalled();

    mountSolid(() => panel);
    await panel.updateComplete;
    expect(panel.activeHostedTabId).toBe("mac-replacement");
    expect(panel.renderRoot.querySelector(".bp-note--error")).toBeNull();
  });

  it.each(["current", "session", "selection", "newer-command", "hide-and-show"] as const)(
    "keeps native command errors with their panel intent: %s",
    async (owner) => {
      const native = fakeNativeBrowser([
        nativeTab("mac-first", "https://example.test/first", "agent:main:first"),
        nativeTab("mac-other", "https://example.test/other", "agent:main:first"),
        nativeTab("mac-second", "https://example.test/second", "agent:main:second"),
      ]);
      const panel = await mountSessionPanel("agent:main:first");
      const reply = createDeferred<{ ok: true }>();
      native.postMessage.mockImplementationOnce(() => reply.promise);
      const reload = () =>
        panel.renderRoot?.querySelector<HTMLButtonElement>('[aria-label="Reload"]')?.click();
      reload();
      expect(native.messages().at(-1)).toEqual({ type: "reload", tabId: "mac-first" });

      if (owner === "session") {
        panel.sessionKey = "agent:main:second";
        await panel.updateComplete;
      } else if (owner === "selection") {
        panel.selectHostedTab("mac-other");
      } else if (owner === "newer-command") {
        reload();
      } else if (owner === "hide-and-show") {
        panel.presented = false;
        await panel.updateComplete;
        panel.presented = true;
        await panel.updateComplete;
      }
      reply.reject(new Error("The earlier reload failed"));
      await flushBrowserResponses();
      await panel.updateComplete;
      const error = panel.renderRoot?.querySelector(".bp-note--error");
      if (owner === "current") {
        expect(error?.textContent).toContain("The earlier reload failed");
      } else {
        expect(error).toBeNull();
      }
    },
  );

  it.each(["current", "selection", "renew", "hide-and-show"] as const)(
    "keeps native presentation errors with their presentation: %s",
    async (owner) => {
      const native = fakeNativeBrowser([nativeTab("mac-one"), nativeTab("mac-two")]);
      const { controller, host } = controllerFixture();
      const reply = createDeferred<{ ok: true }>();
      native.postMessage.mockImplementationOnce(() => reply.promise);
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({ type: "present", tabId: "mac-one" });

      if (owner === "selection" || owner === "renew") {
        await controller.selectTab(owner === "selection" ? "mac-two" : "mac-one");
      } else if (owner === "hide-and-show") {
        host.open = false;
        controller.native.presentation.update();
        host.open = true;
        controller.native.presentation.update();
      }
      flushFrames();
      reply.reject(new Error("The earlier presentation failed"));
      await flushBrowserResponses();
      if (owner === "current") {
        expect(controller.errorText).toContain("The earlier presentation failed");
      } else {
        expect(controller.errorText).toBeNull();
      }
    },
  );
});
