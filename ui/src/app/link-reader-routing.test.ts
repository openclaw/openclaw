/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import { linkReaderResponseMatchesTarget } from "../components/link-reader-response.ts";
import { linkReaderTargetKey, resolveLinkReaderTarget } from "../components/link-reader-target.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { listen } from "../lib/reactive/listener.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { availableLinkReaders, startLinkReaderRouting } from "./link-reader-routing.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";

const reader: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "items",
  label: "Forge",
  linkReader: {
    hosts: ["forge.example"],
    pathPattern: "^/items/[1-9][0-9]*$",
    detailMethod: "forge.item",
  },
};
const readerCapabilities = (controlUiLinkReaders = [reader]) => ({
  ok: true as const,
  descriptors: [],
  methods: ["forge.item"],
  controlUiLinkReaders,
});
const itemUrl = "https://forge.example/items/123";
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function setup(shouldOpenExternally?: () => boolean) {
  const snapshot: ApplicationGatewaySnapshot = createApplicationGatewaySnapshot({
    phase: "connected",
    client: createTestGatewayClient(vi.fn()),
    hello: gatewayHelloForMethods(["forge.item"], ["operator.read"]),
    pluginCapabilities: readerCapabilities(),
  });
  const router = startLinkReaderRouting(() => snapshot, { shouldOpenExternally });
  onTestFinished(router.dispose);
  const accept = vi.fn((event: Event) => event.preventDefault());
  onTestFinished(listen(window, LINK_READER_PANEL_TOGGLE_EVENT, accept));
  const shell = document.createElement("openclaw-app-shell");
  const anchor = document.createElement("a");
  anchor.href = itemUrl;
  shell.append(anchor);
  document.body.append(shell);
  const click = (init: MouseEventInit = {}) => {
    const event = new MouseEvent("click", {
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    });
    return anchor.dispatchEvent(event);
  };
  return { snapshot, anchor, accept, click };
}

describe("Plugin reader link routing", () => {
  it("retains discovered readers offline and retires them on client or fresh access changes", () => {
    const { snapshot } = setup();
    expect(availableLinkReaders(snapshot)).toEqual([reader]);
    snapshot.phase = "reconnecting";
    snapshot.pluginCapabilities = null;
    expect(availableLinkReaders(snapshot)).toEqual([reader]);
    snapshot.phase = "connected";
    snapshot.pluginCapabilities = readerCapabilities([structuredClone(reader)]);
    expect(availableLinkReaders(snapshot)[0]).toBe(reader);
    snapshot.phase = "reconnecting";
    snapshot.client = createTestGatewayClient(vi.fn());
    expect(availableLinkReaders(snapshot)).toEqual([]);
    snapshot.phase = "connected";
    snapshot.pluginCapabilities = readerCapabilities();
    snapshot.hello = gatewayHelloForMethods(["forge.item"], []);
    expect(availableLinkReaders(snapshot)).toEqual([]);
  });
  it.each([false, true])(
    "honors the external preference before readers and browser panels (native: %s)",
    (native) => {
      let external = true;
      const shouldOpenExternally = () => external;
      const { anchor, accept, click } = setup(shouldOpenExternally);
      const postMessage = vi.fn();
      if (native) {
        vi.stubGlobal("webkit", {
          messageHandlers: {
            openclawLink: { postMessage },
            openclawBrowser: { postMessage: vi.fn() },
          },
        });
      }
      const panel = vi.fn();
      onTestFinished(listen(window, BROWSER_PANEL_TOGGLE_EVENT, panel));
      const routing = startNativeLinkRouting({
        shouldOpenExternally,
        shouldOpenInControlUiBrowser: () => true,
      });
      onTestFinished(() => routing.dispose());

      expect(click()).toBe(!native);
      expect(accept).not.toHaveBeenCalled();
      expect(panel).not.toHaveBeenCalled();
      const message = { type: "open-link", url: itemUrl, target: "external" };
      expect(postMessage.mock.calls).toEqual(native ? [[message]] : []);

      external = false;
      expect(click()).toBe(false);
      expect(accept).toHaveBeenCalledOnce();
      const request = accept.mock.calls[0]?.[0];
      expect(request).toBeInstanceOf(CustomEvent);
      expect((request as CustomEvent).detail).toEqual({
        url: anchor.href,
        open: true,
        trigger: anchor,
        newTab: true,
      });
      expect(panel).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledTimes(native ? 1 : 0);
    },
  );

  it.each(["modified", "download", "data-file-path", "data-link-reader-external"])(
    "preserves %s navigation",
    (variant) => {
      const { anchor, accept, click } = setup();
      if (variant !== "modified") {
        anchor.setAttribute(variant, "");
      }
      expect(click({ metaKey: variant === "modified" })).toBe(true);
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it("keeps preview opt-out links routed through the original reader handler", () => {
    const { anchor, accept, click } = setup();
    anchor.setAttribute("data-link-reader-preview", "off");
    expect(click()).toBe(false);
    expect(accept).toHaveBeenCalledOnce();
    expect((accept.mock.calls[0]![0] as CustomEvent).detail.url).toBe(anchor.href);
  });

  it("does not swallow links without an available and accepting shell", () => {
    const { snapshot, accept, click } = setup();
    snapshot.pluginCapabilities!.methods = [];
    expect(click()).toBe(true);
    snapshot.pluginCapabilities!.methods = ["forge.item"];
    snapshot.pluginCapabilities!.controlUiLinkReaders = [];
    expect(click()).toBe(true);
    snapshot.pluginCapabilities!.controlUiLinkReaders = [reader];
    snapshot.phase = "offline";
    expect(click()).toBe(true);
    snapshot.phase = "connected";
    snapshot.hello!.auth!.scopes = [];
    expect(click()).toBe(true);
    snapshot.hello!.auth!.scopes = ["operator.read"];
    window.removeEventListener(LINK_READER_PANEL_TOGGLE_EVENT, accept);
    expect(click()).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("Plugin reader destinations", () => {
  it("keys canonical URLs without losing query identity when fragments change", () => {
    const canonical = `${itemUrl}?label=%23one`;
    const target = resolveLinkReaderTarget(
      "HTTPS://FORGE.EXAMPLE:443/items/123?label=%23one#start",
      [reader],
    )!;
    expect(linkReaderTargetKey(target)).toBe(`forge:items:${canonical}`);
    expect(linkReaderResponseMatchesTarget(target, `${canonical}#other`)).toBe(true);
    expect(linkReaderResponseMatchesTarget(target, `${itemUrl}?label=%23two#start`)).toBe(false);
  });

  it("only claims URLs declared by an enabled plugin, including a non-forge provider", () => {
    const notes: ControlUiLinkReaderDescriptor = {
      pluginId: "notes",
      id: "notes",
      label: "Notes",
      linkReader: {
        hosts: ["notes.example"],
        pathPattern: "^/documents/[a-z-]+$",
        detailMethod: "notes.read",
      },
    };
    expect(
      resolveLinkReaderTarget("https://notes.example/documents/hello-world#discussion", [
        reader,
        notes,
      ]),
    ).toEqual({ href: "https://notes.example/documents/hello-world#discussion", reader: notes });
    expect(resolveLinkReaderTarget(itemUrl, [])).toBeNull();
    const malformed = { ...reader, linkReader: { ...reader.linkReader, pathPattern: "[" } };
    expect(resolveLinkReaderTarget(itemUrl, [malformed, reader])?.reader).toBe(reader);
  });
  it.each([
    "https://forge.example.evil.test/items/1",
    "http://forge.example/items/1",
    "https://forge.example:8443/items/1",
    "https://forge.example/items/0",
    "not-a-url",
    "https://example:not-a-real-password@forge.example/items/1",
  ])("leaves unsupported URLs external: %s", (url) => {
    expect(resolveLinkReaderTarget(url, [reader])).toBeNull();
  });
});
