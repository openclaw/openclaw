import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import { resolveLinkReaderTarget, EMPTY_LINK_READERS } from "../components/link-reader-target.ts";
import {
  LINK_READER_PANEL_TOGGLE_EVENT,
  type LinkReaderPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

export function availableLinkReaders(
  snapshot: ApplicationGatewaySnapshot,
): readonly ControlUiLinkReaderDescriptor[] {
  if (snapshot.phase !== "connected") {
    return EMPTY_LINK_READERS;
  }
  return (snapshot.pluginCapabilities?.controlUiLinkReaders ?? EMPTY_LINK_READERS).filter(
    (reader) =>
      snapshot.pluginCapabilities?.methods?.includes(reader.linkReader.detailMethod) === true &&
      canCallGatewayMethod(snapshot, reader.linkReader.detailMethod, "operator.read", {
        requireAdvertisement: false,
      }),
  );
}

export function availableLinkPreviewReaders(
  snapshot: ApplicationGatewaySnapshot,
): readonly ControlUiLinkReaderDescriptor[] {
  return availableLinkReaders(snapshot).filter((reader) =>
    Boolean(
      reader.linkReader.previewMethod &&
      snapshot.pluginCapabilities?.methods?.includes(reader.linkReader.previewMethod),
    ),
  );
}

/** Register before native routing so plugin-supported links have one destination on every host. */
export function startLinkReaderRouting(snapshot: () => ApplicationGatewaySnapshot) {
  const handleClick = (event: MouseEvent) => {
    if (!shouldHandleNavigationClick(event) || snapshot().phase !== "connected") {
      return;
    }
    const path = event.composedPath();
    const anchor = path.find(
      (element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement,
    );
    if (
      !anchor ||
      !path.some(
        (element) => element instanceof Element && element.localName === "openclaw-app-shell",
      ) ||
      anchor.hasAttribute("download") ||
      anchor.hasAttribute("data-file-path") ||
      anchor.hasAttribute("data-link-reader-external")
    ) {
      return;
    }
    const target = resolveLinkReaderTarget(anchor.href, availableLinkReaders(snapshot()));
    if (!target) {
      return;
    }
    // Prevent navigation only after the shell accepts the request. Unmounted
    // shells and unavailable surfaces must leave the ordinary link working.
    const request = new CustomEvent<LinkReaderPanelToggleDetail>(LINK_READER_PANEL_TOGGLE_EVENT, {
      cancelable: true,
      detail: {
        url: target.href,
        open: true,
        trigger: anchor,
        newTab: !path.some(
          (element) =>
            element instanceof Element && element.localName === "openclaw-link-reader-panel",
        ),
      },
    });
    if (!window.dispatchEvent(request)) {
      event.preventDefault();
    }
  };
  document.addEventListener("click", handleClick);
  return { dispose: () => document.removeEventListener("click", handleClick) };
}
