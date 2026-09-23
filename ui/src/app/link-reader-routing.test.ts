/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import { linkReaderResponseMatchesTarget } from "../components/link-reader-response.ts";
import { linkReaderTargetKey, resolveLinkReaderTarget } from "../components/link-reader-target.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
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

function setup() {
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
  const router = startLinkReaderRouting(() => snapshot);
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
  it("routes primary clicks once before native webview handling, retaining the original URL", () => {
    const { anchor, accept, click } = setup();
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
    const nativeRouting = startNativeLinkRouting();
    cleanups.push(() => nativeRouting.dispose());
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
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each([
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ])("preserves modified/native navigation %j", (init) => {
    const { accept, click } = setup();
    expect(click(init).allowed).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each(["download", "data-file-path", "data-link-reader-external"])(
    "preserves explicit %s links",
    (attribute) => {
      const { anchor, accept, click } = setup();
      anchor.setAttribute(attribute, "");
      expect(click().allowed).toBe(true);
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
    expect(resolveLinkReaderTarget("https://forge.example/items/123", [reader])?.reader).toBe(
      reader,
    );
  });
  it.each([
    "https://forge.example.evil.test/items/1",
    "http://forge.example/items/1",
    "https://forge.example:8443/items/1",
    "https://forge.example/items/0",
    "https://forge.example/items/new",
    "https://forge.example/items/1/extra",
    "https://forge.example/items/%2F",
    "file:///items/1",
    "not-a-url",
  ])("leaves unsupported URLs external: %s", (url) => {
    expect(resolveLinkReaderTarget(url, [reader])).toBeNull();
  });
  it("rejects userinfo and ignores a malformed contribution without breaking other links", () => {
    const url = new URL("https://forge.example/items/1");
    url.username = "example";
    url.password = "not-a-real-password";
    expect(resolveLinkReaderTarget(url.href, [reader])).toBeNull();
    const malformed = { ...reader, linkReader: { ...reader.linkReader, pathPattern: "[" } };
    expect(
      resolveLinkReaderTarget("https://forge.example/items/1", [malformed, reader])?.reader,
    ).toBe(reader);
  });
});
