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
  const { client, hello, phase, pluginCapabilities: capabilities } = snapshot;
  if (!client || client.offlineRecoveryRetired) {
    return EMPTY_LINK_READERS;
  }
  const { recoveryScope } = client;
  const catalog = readerCatalogs.get(client);
  const previous = catalog?.recoveryScope === recoveryScope ? catalog : undefined;
  if (phase !== "connected") {
    return previous?.readers ?? EMPTY_LINK_READERS;
  }
  if (previous && previous.hello === hello && previous.capabilities === capabilities) {
    return previous.readers;
  }
  const retained: ControlUiLinkReaderDescriptor[] = [];
  for (const reader of capabilities?.controlUiLinkReaders ?? EMPTY_LINK_READERS) {
    const metadata = reader.linkReader;
    const { detailMethod } = metadata;
    if (
      !capabilities?.methods?.includes(detailMethod) ||
      !canCallGatewayMethod(snapshot, detailMethod, "operator.read", {
        requireAdvertisement: false,
      })
    ) {
      continue;
    }
    const prior = previous?.readers.find(
      (entry) => entry.pluginId === reader.pluginId && entry.id === reader.id,
    );
    if (prior) {
      const old = prior.linkReader;
      if (
        prior.label === reader.label &&
        prior.icon === reader.icon &&
        old.pathPattern === metadata.pathPattern &&
        old.detailMethod === detailMethod &&
        old.previewMethod === metadata.previewMethod &&
        old.imageMethod === metadata.imageMethod &&
        old.sessionScoped === metadata.sessionScoped &&
        old.progressive === metadata.progressive &&
        old.hosts.length === metadata.hosts.length &&
        old.hosts.every((host, index) => host === metadata.hosts[index])
      ) {
        retained.push(prior);
        continue;
      }
    }
    retained.push(reader);
  }
  readerCatalogs.set(client, { recoveryScope, hello, capabilities, readers: retained });
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
    if (options.shouldOpenExternally?.() || !shouldHandleNavigationClick(event)) {
      return;
    }
    const gateway = snapshot();
    if (gateway.phase !== "connected") {
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
      anchor.matches("[download],[data-file-path],[data-link-reader-external]")
    ) {
      return;
    }
    const target = resolveLinkReaderTarget(anchor.href, availableLinkReaders(gateway));
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
      },
    });
    if (!window.dispatchEvent(request)) {
      event.preventDefault();
    }
  };
  return { dispose: listen(document, "click", handleClick) };
}
