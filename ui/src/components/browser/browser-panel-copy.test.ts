import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { showToast } from "../../lib/toast.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { stubResizeObserver } from "../../test-helpers/resize-observer.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createView,
  openBrowserActions,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  type BrowserRequestEnvelope,
  type TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import "./browser-panel.ts";

vi.mock("../../lib/toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/toast.ts")>()),
  showToast: vi.fn(() => true),
}));

setupBrowserPanelTestCleanup();

const url = "https://example.test/page";
const writeText = vi.fn();

function selected(text: string, truncated = false) {
  return { text, length: text.length, truncated };
}

/** A remote page whose selection reads come from `read`; probes never ask for the text. */
function createRemote(read: (probeOnly: boolean) => unknown = () => selected("")) {
  const requests: BrowserRequestEnvelope[] = [];
  const gateway = createBrowserClient(async (envelope) => {
    requests.push(envelope);
    if (envelope.path === "/tabs") {
      return {
        running: true,
        tabs: [
          createBrowserPanelTestTab("tab-1", url, "Page"),
          createBrowserPanelTestTab("tab-2", url, "Other"),
        ],
      };
    }
    if (envelope.path === "/screenshot") {
      return { path: "/fresh.png", targetId: envelope.body?.targetId, url };
    }
    if (envelope.path === "/act" && envelope.body?.kind === "evaluate") {
      const fn = String(envelope.body.fn);
      return fn.includes("openclawReadBrowserSelection")
        ? { result: await read(fn.includes(", true);")) }
        : createBrowserPanelTestMetrics(url);
    }
    return { ok: true };
  });
  const acts = (kind: string) =>
    requests.flatMap((request) =>
      request.path === "/act" && request.body?.kind === kind ? [request.body] : [],
    );
  return { ...gateway, requests, acts };
}

const toasts = () => vi.mocked(showToast).mock.calls.map(([options]) => options.message);
const key = (options: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  vi.mocked(showToast).mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal("localStorage", createStorageMock());
  stubResizeObserver();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.replaceChildren();
});

describe("Browser panel copy", () => {
  function setup(read?: Parameters<typeof createRemote>[0]) {
    const remote = createRemote(read);
    const controller = createBrowserPanelTestController(remote.client, "tab-1", url);
    return { remote, controller, host: controller.host as TestBrowserPanelHost };
  }

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "copies the remote selection on %j and does not forward the key",
    async (modifier) => {
      const { remote, controller } = setup(() => selected("remote 🦞 text"));
      const event = key({ key: "c", ...modifier });
      controller.input.handleViewportKeydown(event);

      await vi.waitFor(() => expect(toasts()).toEqual(["Copied!"]));
      expect(event.defaultPrevented).toBe(true);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("remote 🦞 text");
      expect(remote.acts("press")).toEqual([]);
      expect(remote.acts("insertText")).toEqual([]);
    },
  );

  it("leaves chords the browser owns alone", () => {
    const { remote, controller } = setup(() => selected("never read"));
    for (const chord of [
      { key: "c", ctrlKey: true, shiftKey: true },
      { key: "c", metaKey: true, altKey: true },
      { key: "x", ctrlKey: true },
    ]) {
      const event = key(chord);
      controller.input.handleViewportKeydown(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(remote.requests).toEqual([]);
  });

  it("names a selection truncated at the size cap", async () => {
    const { controller } = setup(() => selected("abc", true));
    controller.input.copySelection();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("abc"));
    expect(toasts()).toEqual([
      "Copied. The selection was too long, so only the first 1000000 characters were copied.",
    ]);
  });

  it("explains an empty selection and leaves the clipboard alone", async () => {
    const { controller } = setup(() => selected(""));
    controller.input.copySelection();

    await vi.waitFor(() =>
      expect(toasts()).toEqual([
        "Nothing is selected in the page. Ask the agent to select text, then copy again.",
      ]),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reports an unreadable page without echoing the failure", async () => {
    const { controller } = setup(() => {
      throw new Error("Request failed: hunter2");
    });
    controller.input.copySelection();

    await vi.waitFor(() =>
      expect(toasts()).toEqual([
        "Couldn’t read the page selection. Check the browser connection and try again.",
      ]),
    );
    expect(controller.errorText).toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("explains disabled page scripting and stops asking", async () => {
    const { remote, controller } = setup(() => {
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Evaluation disabled",
        details: { code: "ACT_EVALUATE_DISABLED" },
      });
    });
    controller.input.copySelection();
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    controller.input.copySelection();

    expect(toasts()).toEqual(Array(2).fill(expect.stringContaining("browser.evaluateEnabled")));
    expect(controller.evaluateUnavailable).toBe(true);
    expect(remote.acts("evaluate")).toHaveLength(1);
  });

  it("asks to reconnect while the panel is disconnected", () => {
    const { remote, controller, host } = setup();
    host.isConnected = false;
    controller.input.copySelection();

    expect(toasts()).toEqual(["Couldn’t copy. Reconnect to the browser and try again."]);
    expect(remote.requests).toEqual([]);
  });

  it.each(["tab", "connection"] as const)(
    "drops a selection read that finishes after the %s changed",
    async (change) => {
      const pending = createDeferred<unknown>();
      const { remote, controller, host } = setup(() => pending.promise);
      controller.input.copySelection();
      await vi.waitFor(() => expect(remote.acts("evaluate")).toHaveLength(1));
      if (change === "tab") {
        controller.setState("activeTargetId", "tab-2");
        controller.setState("view", createView("tab-2"));
      } else {
        host.isConnected = false;
      }
      pending.resolve(selected("text of the old page"));
      await pending.promise;
      await vi.waitFor(() => expect(remote.acts("evaluate")).toHaveLength(1));

      expect(writeText).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    },
  );

  it("reports a clipboard write failure", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    const { controller } = setup(() => selected("keep me"));
    controller.input.copySelection();

    await vi.waitFor(() =>
      expect(toasts()).toEqual([
        "Couldn’t write to your clipboard. Allow clipboard access and try again.",
      ]),
    );
  });

  it("reads the selection only after an earlier click reached the page", async () => {
    const { remote, controller } = setup(() => selected("clicked field"));
    controller.input.handleStageClick(new MouseEvent("click", { clientX: 10, clientY: 20 }));
    controller.input.copySelection();

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("clicked field"));
    const order = remote.requests.map((request) => String(request.body?.kind));
    expect(order.indexOf("clickCoords")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("clickCoords")).toBeLessThan(order.lastIndexOf("evaluate"));
  });
});

describe("Browser panel copy rendering", () => {
  async function mountRemote(read?: Parameters<typeof createRemote>[0]) {
    stubScreenshotMedia();
    const remote = createRemote(read);
    const panel = document.createElement("openclaw-browser-panel");
    Object.assign(panel, {
      available: true,
      embedded: true,
      presented: true,
      client: remote.client,
    });
    mountSolid(() => panel);
    await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
    return { panel, remote };
  }

  const copyItem = (menu: HTMLElement) =>
    menu.querySelector<HTMLElement>('[role="menuitem"][aria-label="Copy selection"]')!;

  it("copies for the native copy event from the input proxy", async () => {
    const { panel } = await mountRemote(() => selected("from the page"));
    const copy = new Event("copy", { bubbles: true, composed: true, cancelable: true });
    const outer = vi.fn();
    panel.addEventListener("copy", outer);
    panel.querySelector(".bp-input")!.dispatchEvent(copy);

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("from the page"));
    expect(copy.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
  });

  it("offers Copy selection only while the page has selected text", async () => {
    let remoteSelection = "";
    const { panel, remote } = await mountRemote(() => selected(remoteSelection));
    let menu = await openBrowserActions(panel);
    expect(copyItem(menu).getAttribute("aria-disabled")).toBe("true");
    await waitForSolid(() =>
      expect(copyItem(menu).getAttribute("title")).toBe(
        "Ask the agent to select text in the page first.",
      ),
    );
    // The probe asks for the size only, never the text.
    expect(String(remote.acts("evaluate").at(-1)?.fn)).toContain(", true);");
    panel.querySelector<HTMLButtonElement>('.bp-toolbar button[aria-haspopup="menu"]')!.click();
    await waitForSolid(() =>
      expect(menu.matches(":popover-open, [data-state='open']")).toBe(false),
    );

    remoteSelection = "hello";
    menu = await openBrowserActions(panel);
    await waitForSolid(() => expect(copyItem(menu).getAttribute("aria-disabled")).not.toBe("true"));
    copyItem(menu).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("hello"));
    expect(toasts()).toEqual(["Copied!"]);
  });

  it("disables Copy selection with the reason when page scripting is off", async () => {
    const { panel } = await mountRemote(() => {
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Evaluation disabled",
        details: { code: "ACT_EVALUATE_DISABLED" },
      });
    });
    const menu = await openBrowserActions(panel);
    await waitForSolid(() =>
      expect(copyItem(menu).getAttribute("title")).toContain("browser.evaluateEnabled=false"),
    );
    expect(copyItem(menu).getAttribute("aria-disabled")).toBe("true");
  });
});
