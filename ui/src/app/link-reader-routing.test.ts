/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import { linkReaderResponseMatchesTarget } from "../components/link-reader-response.ts";
import { linkReaderTargetKey, resolveLinkReaderTarget } from "../components/link-reader-target.ts";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
} from "../components/panel-toggle-contract.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { startLinkReaderRouting } from "./link-reader-routing.ts";
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
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function setup(shouldOpenExternally?: () => boolean) {
  const snapshot: ApplicationGatewaySnapshot = {
    phase: "connected",
    client: createTestGatewayClient(vi.fn()),
    hello: gatewayHelloForMethods(["forge.item"], ["operator.read"]),
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: null,
    sessionKey: "",
    lastError: null,
    lastErrorCode: null,
    pluginCapabilities: {
      ok: true,
      descriptors: [],
      methods: ["forge.item"],
      controlUiLinkReaders: [reader],
    },
  };
  const router = startLinkReaderRouting(() => snapshot, { shouldOpenExternally });
  cleanups.push(router.dispose);
  const accept = vi.fn((event: Event) => event.preventDefault());
  window.addEventListener(LINK_READER_PANEL_TOGGLE_EVENT, accept);
  cleanups.push(() => window.removeEventListener(LINK_READER_PANEL_TOGGLE_EVENT, accept));
  const shell = document.createElement("openclaw-app-shell");
  const anchor = document.createElement("a");
  anchor.href = "https://forge.example/items/123";
  shell.append(anchor);
  document.body.append(shell);
  const click = (init: MouseEventInit = {}) => {
    const event = new MouseEvent("click", {
      bubbles: true,
      composed: true,
      cancelable: true,
      ...init,
    });
    // The document capture handlers decide ownership before this test suppresses jsdom navigation.
    const allowed = anchor.dispatchEvent(event);
    return { event, allowed };
  };
  return { snapshot, anchor, accept, click };
}

describe("Plugin reader link routing", () => {
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
      window.addEventListener(BROWSER_PANEL_TOGGLE_EVENT, panel);
      cleanups.push(() => window.removeEventListener(BROWSER_PANEL_TOGGLE_EVENT, panel));
      const routing = startNativeLinkRouting({
        shouldOpenExternally,
        shouldOpenInControlUiBrowser: () => true,
      });
      cleanups.push(() => routing.dispose());

      expect(click().allowed).toBe(!native);
      expect(accept).not.toHaveBeenCalled();
      expect(panel).not.toHaveBeenCalled();
      expect(postMessage.mock.calls).toEqual(
        native
          ? [
              [
                {
                  type: "open-link",
                  url: "https://forge.example/items/123",
                  target: "external",
                },
              ],
            ]
          : [],
      );

      external = false;
      expect(click().allowed).toBe(false);
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
      expect(click({ metaKey: variant === "modified" }).allowed).toBe(true);
      expect(accept).not.toHaveBeenCalled();
    },
  );

  it("does not swallow links without an available and accepting shell", () => {
    const { snapshot, accept, click } = setup();
    snapshot.pluginCapabilities!.methods = [];
    expect(click().allowed).toBe(true);
    snapshot.pluginCapabilities!.methods = ["forge.item"];
    snapshot.pluginCapabilities!.controlUiLinkReaders = [];
    expect(click().allowed).toBe(true);
    snapshot.pluginCapabilities!.controlUiLinkReaders = [reader];
    snapshot.phase = "offline";
    expect(click().allowed).toBe(true);
    snapshot.phase = "connected";
    snapshot.hello!.auth!.scopes = [];
    expect(click().allowed).toBe(true);
    snapshot.hello!.auth!.scopes = ["operator.read"];
    window.removeEventListener(LINK_READER_PANEL_TOGGLE_EVENT, accept);
    expect(click().allowed).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("Plugin reader destinations", () => {
  it("keys canonical URLs without losing query identity when fragments change", () => {
    const target = resolveLinkReaderTarget(
      "HTTPS://FORGE.EXAMPLE:443/items/123?label=%23one#start",
      [reader],
    )!;
    expect(linkReaderTargetKey(target)).toBe(
      "forge:items:https://forge.example/items/123?label=%23one",
    );
    expect(
      linkReaderResponseMatchesTarget(target, "https://forge.example/items/123?label=%23one#other"),
    ).toBe(true);
    expect(
      linkReaderResponseMatchesTarget(target, "https://forge.example/items/123?label=%23two#start"),
    ).toBe(false);
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
    expect(resolveLinkReaderTarget("https://forge.example/items/123", [])).toBeNull();
    const malformed = { ...reader, linkReader: { ...reader.linkReader, pathPattern: "[" } };
    expect(
      resolveLinkReaderTarget("https://forge.example/items/123", [malformed, reader])?.reader,
    ).toBe(reader);
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
