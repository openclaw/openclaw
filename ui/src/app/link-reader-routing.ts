import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import { resolveLinkReaderTarget, EMPTY_LINK_READERS } from "../components/link-reader-target.ts";
import {
  LINK_READER_PANEL_TOGGLE_EVENT,
  type LinkReaderPanelToggleDetail,
} from "../components/panel-toggle-contract.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

const readerCatalogs = new WeakMap<
  NonNullable<ApplicationGatewaySnapshot["client"]>,
  {
    recoveryScope: string;
    hello: ApplicationGatewaySnapshot["hello"];
    capabilities: ApplicationGatewaySnapshot["pluginCapabilities"];
    readers: readonly ControlUiLinkReaderDescriptor[];
  }
>();

export function availableLinkReaders(
  snapshot: ApplicationGatewaySnapshot,
): readonly ControlUiLinkReaderDescriptor[] {
  const client = snapshot.client;
  if (!client || client.offlineRecoveryRetired) {
    return EMPTY_LINK_READERS;
  }
  const catalog = readerCatalogs.get(client);
  const previous = catalog && catalog.recoveryScope === client.recoveryScope ? catalog : undefined;
  if (snapshot.phase !== "connected") {
    return previous?.readers ?? EMPTY_LINK_READERS;
  }
  if (
    previous &&
    previous.hello === snapshot.hello &&
    previous.capabilities === snapshot.pluginCapabilities
  ) {
    return previous.readers;
  }
  const readers = (snapshot.pluginCapabilities?.controlUiLinkReaders ?? EMPTY_LINK_READERS).filter(
    (reader) =>
      snapshot.pluginCapabilities?.methods?.includes(reader.linkReader.detailMethod) === true &&
      canCallGatewayMethod(snapshot, reader.linkReader.detailMethod, "operator.read", {
        requireAdvertisement: false,
      }),
  );
  const retained = readers.map((reader) => {
    const prior = previous?.readers.find(
      (entry) => entry.pluginId === reader.pluginId && entry.id === reader.id,
    );
    const metadata = reader.linkReader;
    const priorMetadata = prior?.linkReader;
    return prior &&
      priorMetadata &&
      prior.label === reader.label &&
      prior.icon === reader.icon &&
      priorMetadata.pathPattern === metadata.pathPattern &&
      priorMetadata.detailMethod === metadata.detailMethod &&
      priorMetadata.previewMethod === metadata.previewMethod &&
      priorMetadata.imageMethod === metadata.imageMethod &&
      priorMetadata.sessionScoped === metadata.sessionScoped &&
      priorMetadata.progressive === metadata.progressive &&
      priorMetadata.hosts.length === metadata.hosts.length &&
      priorMetadata.hosts.every((host, index) => host === metadata.hosts[index])
      ? prior
      : reader;
  });
  readerCatalogs.set(client, {
    recoveryScope: client.recoveryScope,
    hello: snapshot.hello,
    capabilities: snapshot.pluginCapabilities,
    readers: retained,
  });
  return retained;
}

export function availableLinkPreviewReaders(
  snapshot: ApplicationGatewaySnapshot,
): readonly ControlUiLinkReaderDescriptor[] {
  return availableLinkReaders(snapshot).filter((reader) =>
    Boolean(
      reader.linkReader.previewMethod &&
      (snapshot.phase !== "connected" ||
        snapshot.pluginCapabilities?.methods?.includes(reader.linkReader.previewMethod)),
    ),
  );
}

/** Register before native routing so plugin-supported links have one destination on every host. */
export function startLinkReaderRouting(
  snapshot: () => ApplicationGatewaySnapshot,
  options: { shouldOpenExternally?: () => boolean } = {},
) {
  const handleClick = (event: MouseEvent) => {
    if (
      options.shouldOpenExternally?.() ||
      !shouldHandleNavigationClick(event) ||
      snapshot().phase !== "connected"
    ) {
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
  return { dispose: listen(document, "click", handleClick) };
}
