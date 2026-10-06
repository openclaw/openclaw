import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { flushBrowserResponses } from "./browser-panel-controller-test-support.ts";
import {
  fakeNativeBrowser,
  mountSessionPanel,
  nativeTab,
  setupNativeBrowserPanelTests,
} from "./test-helpers/native-browser.ts";

const { controllerFixture, flushFrames } = setupNativeBrowserPanelTests();

describe("native Browser panel reply ownership", () => {
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
        panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Reload"]')?.click();
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
      const error = panel.shadowRoot?.querySelector(".bp-note--error");
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
        controller.hostUpdated();
        host.open = true;
        controller.hostUpdated();
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
