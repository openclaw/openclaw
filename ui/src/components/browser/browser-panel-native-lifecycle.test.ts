import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createInitializationContext } from "../../pages/chat/chat-pane.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
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
const urlOf = (panel: Element) => panel.querySelector<HTMLInputElement>(".bp-url")?.value;
const createPanel = () =>
  Object.assign(document.createElement("openclaw-browser-panel"), {
    available: true,
    remoteAvailable: false,
    embedded: true,
    presented: true,
  });
it.each(["reconnect", "context"])("rebinds publications after %s", async (transition) => {
  const native = fakeNativeBrowser([nativeTab("mac-first")]);
  const first = createInitializationContext();
  const provider = createApplicationContextProvider(first);
  const panel = createPanel();
  provider.append(panel);
  mountSolid(() => provider);
  await panel.updateComplete;
  const viewport = panel.querySelector(".bp-viewport");
  native.publish([nativeTab("mac-queued", "https://example.test/queued")]);
  const pending = panel.updateComplete;
  if (transition === "reconnect") {
    panel.remove();
    await pending;
    provider.append(panel);
  } else {
    provider.setContext({ ...first, basePath: "/replacement" });
    await pending;
  }
  await panel.updateComplete;
  expect(panel.querySelector(".bp-viewport")).not.toBe(viewport);
  expect(panel.activeHostedTabId).toBe("mac-queued");
  expect(urlOf(panel)).toBe("https://example.test/queued");
  native.publish([nativeTab("mac-current", "https://example.test/current")]);
  await panel.updateComplete;
  expect(panel.activeHostedTabId).toBe("mac-current");
  expect(urlOf(panel)).toBe("https://example.test/current");
});

it("retains a pre-mount native open and retires its subscription and replies on disposal", async () => {
  const native = fakeNativeBrowser();
  const panel = createPanel();
  panel.handleToggleRequest(
    new CustomEvent("openclaw:browser-panel-toggle", {
      detail: { open: true, url: "https://example.test/before-mount", native: true },
    }),
  );
  await flushBrowserResponses();
  const mounted = mountSolid(() => panel);
  await panel.updateComplete;
  expect(urlOf(panel)).toBe("https://example.test/before-mount");
  expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(1);
  const reply = createDeferred<{ ok: true }>();
  native.postMessage.mockImplementationOnce(() => reply.promise);
  panel.querySelector<HTMLButtonElement>('[aria-label="Reload"]')!.click();
  expect(native.messages().at(-1)).toMatchObject({ type: "reload" });
  const released = { type: "release-scope", scope: panel.dataset.nativeBrowserScope };
  mounted.unmount();
  await waitForSolid(() => expect(native.messages().at(-1)).toEqual(released));
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
  expect(panel.querySelector(".bp-note--error")).toBeNull();
});

it.each([
  ["command", "current"],
  ["command", "session"],
  ["command", "selection"],
  ["command", "newer-command"],
  ["command", "hide-and-show"],
  ["presentation", "current"],
  ["presentation", "selection"],
  ["presentation", "renew"],
  ["presentation", "hide-and-show"],
])("keeps native %s errors with their owner: %s", async (kind, owner) => {
  const native = fakeNativeBrowser(
    kind === "command"
      ? ["first", "other", "second"].map((id) =>
          nativeTab(`mac-${id}`, undefined, `agent:main:${id === "second" ? id : "first"}`),
        )
      : [nativeTab("mac-one"), nativeTab("mac-two")],
  );
  const panel = kind === "command" ? await mountSessionPanel("agent:main:first") : null;
  const fixture = panel ? null : controllerFixture();
  const reply = createDeferred<{ ok: true }>();
  native.postMessage.mockImplementationOnce(() => reply.promise);
  const reload = () => panel?.querySelector<HTMLButtonElement>('[aria-label="Reload"]')?.click();
  (panel ? reload : flushFrames)();
  expect(native.messages().at(-1)).toEqual(
    panel
      ? { type: "reload", tabId: "mac-first" }
      : expect.objectContaining({ type: "present", tabId: "mac-one" }),
  );
  if (panel && owner === "session") {
    panel.sessionKey = "agent:main:second";
    await panel.updateComplete;
  } else if (panel && owner === "selection") {
    panel.selectHostedTab("mac-other");
  } else if (owner === "newer-command") {
    reload();
  } else if (fixture && (owner === "selection" || owner === "renew")) {
    await fixture.controller.selectTab(owner === "selection" ? "mac-two" : "mac-one");
  } else if (owner === "hide-and-show") {
    for (const open of [false, true]) {
      if (panel) {
        panel.presented = open;
        await panel.updateComplete;
      } else if (fixture) {
        fixture.host.open = open;
        fixture.controller.native.presentation.update();
      }
    }
  }
  if (fixture) {
    flushFrames();
  }
  const message = `The earlier ${kind === "command" ? "reload" : kind} failed`;
  reply.reject(new Error(message));
  await flushBrowserResponses();
  await panel?.updateComplete;
  const error =
    panel?.querySelector(".bp-note--error")?.textContent ?? fixture?.controller.errorText;
  expect(error ?? null).toEqual(owner === "current" ? expect.stringContaining(message) : null);
});
