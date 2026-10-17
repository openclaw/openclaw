import { onSettled } from "solid-js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { listen } from "../../../lib/reactive/listener.ts";

export type ChatCiDisclosureProps = {
  gateway?: ApplicationGateway;
  pullRequest?: ControlUiSessionPullRequest;
  sessionKey: string;
  presented: boolean;
};

/** The disclosure owns visibility; the two CI projections own their request fences. */
export function createCiDisclosure(
  host: HTMLElement & Pick<ChatCiDisclosureProps, "presented">,
  onVisibility: () => void,
  dispose: () => void,
) {
  let disclosure: HTMLDetailsElement | null = null;
  let active = false;
  const isConnected = () => active && host.isConnected;
  const visible = () =>
    isConnected() &&
    host.presented &&
    disclosure?.open === true &&
    host.ownerDocument.visibilityState !== "hidden";
  onSettled(() => {
    active = true;
    disclosure = host.closest<HTMLDetailsElement>(".chat-pr__checks");
    const document = host.ownerDocument;
    const toggle = (event: Event) => {
      if (event.target === disclosure) {
        onVisibility();
      }
    };
    const stopToggle = disclosure && listen(disclosure, "toggle", toggle);
    const stopVisibility = listen(document, "visibilitychange", onVisibility);
    onVisibility();
    return () => {
      active = false;
      stopToggle?.();
      stopVisibility();
      dispose();
    };
  });
  return {
    isConnected,
    visible,
    close: () => {
      if (disclosure) {
        disclosure.open = false;
      }
    },
  };
}
