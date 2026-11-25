import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createPanelPresentationLifecycle } from "./panel-presentation-lifecycle.ts";

export type LinkReaderPanelProps = {
  client: GatewayBrowserClient | null;
  available: boolean;
  agentId: string | undefined;
  readers: readonly ControlUiLinkReaderDescriptor[];
  suppressed: boolean;
  embedded: boolean;
  presented: boolean;
  tabsInHeader: boolean;
  sessionKey: string;
  onClose: (() => void) | undefined;
};

export type LinkReaderPanelElements = {
  address: HTMLInputElement | undefined;
  content: HTMLElement | undefined;
};

/** Publishes the panel's current inputs after their DOM transition commits. */
export function createLinkReaderPanelLifecycle(
  props: LinkReaderPanelProps,
  scheduleAfterRender: (callback: () => void) => void,
  reconcile: (previous: LinkReaderPanelProps | undefined) => void,
  render: () => void,
) {
  let previousProps: LinkReaderPanelProps | undefined;
  return createPanelPresentationLifecycle(
    scheduleAfterRender,
    () => {
      const previous = previousProps;
      previousProps = {
        client: props.client,
        available: props.available,
        agentId: props.agentId,
        readers: props.readers,
        suppressed: props.suppressed,
        embedded: props.embedded,
        presented: props.presented,
        tabsInHeader: props.tabsInHeader,
        sessionKey: props.sessionKey,
        onClose: props.onClose,
      };
      reconcile(previous);
    },
    render,
  );
}
