import type { JSX } from "@solidjs/web";
import { Show, createMemo, createSignal, onSettled } from "solid-js";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import type { AttachmentAdmission } from "./chat-message-attachment-admission-model.ts";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";

export type AttachmentAdmissionProps = {
  attachments: readonly AttachmentItem["attachment"][];
  options: ImageRenderOptions;
  render: (admission: AttachmentAdmission) => JSX.Element;
};

export function ChatAttachmentAdmission(props: AttachmentAdmissionProps): JSX.Element {
  const scope = () =>
    JSON.stringify([
      props.attachments.map((attachment) => [attachment.url, attachment.artifactId]),
      props.options.sessionKey,
      props.options.agentId,
      props.options.connectionEpoch,
      props.options.resourceBasePath,
      props.options.authToken,
      props.options.policyKey,
    ]);
  return (
    <Show when={scope()} keyed>
      {(_key) => <AdmissionContent render={props.render} />}
    </Show>
  );
}

function AdmissionContent(props: Pick<AttachmentAdmissionProps, "render">): JSX.Element {
  const admission = createAdmission();
  return <>{props.render(admission)}</>;
}

/** Keep a reader mounted while its source receives a fresh viewport admission. */
export function createChatAttachmentAdmission(scope: () => string, immediate: () => boolean) {
  let element: Element | undefined;
  let admission: ReturnType<typeof createAdmission> | undefined;
  const key = createMemo(() => JSON.stringify([scope(), immediate()]));
  const current = createMemo(() => {
    key();
    admission = createAdmission(immediate(), () => element);
    return admission;
  });
  const observeElement = (next: Element | undefined) => {
    element = next;
    admission?.observe(next);
  };
  return {
    get observeElement() {
      current();
      return observeElement;
    },
    onAdmit: () => current().onAdmit(),
    get admitted() {
      return current().admitted;
    },
  };
}

function createAdmission(immediate = false, retainedElement?: () => Element | undefined) {
  let didAdmit = immediate || typeof IntersectionObserver !== "function";
  const [admitted, setAdmitted] = createSignal(didAdmit);
  let active = false;
  let currentElement: Element | undefined;
  let stopObserving: (() => void) | undefined;
  const admit = () => {
    if (!active || didAdmit) {
      return;
    }
    didAdmit = true;
    stopObserving?.();
    stopObserving = undefined;
    setAdmitted(true);
  };
  const observeElement = (element: Element | undefined) => {
    currentElement = element;
    stopObserving?.();
    stopObserving = undefined;
    if (element && active && !didAdmit) {
      stopObserving = observeChatAttachmentViewport(element, admit);
    }
  };
  onSettled(() => {
    active = true;
    observeElement(retainedElement?.() ?? currentElement);
    return () => {
      active = false;
      stopObserving?.();
    };
  });
  return {
    observe: observeElement,
    get observeElement() {
      return admitted() ? undefined : observeElement;
    },
    onAdmit: admit,
    get admitted() {
      return admitted();
    },
  };
}
