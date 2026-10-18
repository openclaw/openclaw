import type { ControlUiLinkReaderDescriptor } from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";

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
) {
  let connected = false;
  let completion: Promise<boolean> = Promise.resolve(true);
  let complete: ((value: boolean) => void) | undefined;
  let previousProps: LinkReaderPanelProps | undefined;
  const listeners = new Set<() => void>();

  function publish(): void {
    if (!connected) {
      return;
    }
    const needsCommit = !complete;
    if (needsCommit) {
      completion = new Promise((resolve) => {
        complete = resolve;
      });
    }
    const pending = complete;
    listeners.forEach((listener) => listener());
    if (needsCommit) {
      scheduleAfterRender(() => {
        // A disposed panel's receipt cannot publish into its replacement.
        if (complete !== pending) {
          return;
        }
        complete = undefined;
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
        pending?.(true);
      });
    }
  }

  return {
    publish,
    active: () => connected,
    get updateComplete() {
      return completion;
    },
    connect() {
      connected = true;
      publish();
    },
    dispose() {
      connected = false;
      complete?.(false);
      complete = undefined;
    },
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
