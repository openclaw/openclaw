import type { JSX } from "@solidjs/web";
import { Show, createSignal, onCleanup } from "solid-js";
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
  let didAdmit = typeof IntersectionObserver !== "function";
  const [admitted, setAdmitted] = createSignal(didAdmit);
  let active = true;
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
    stopObserving?.();
    stopObserving = undefined;
    if (element && active && !didAdmit) {
      stopObserving = observeChatAttachmentViewport(element, admit);
    }
  };
  onCleanup(() => {
    active = false;
    stopObserving?.();
  });
  return (
    <>
      {props.render({
        get observeElement() {
          return admitted() ? undefined : observeElement;
        },
        onAdmit: admit,
      })}
    </>
  );
}
