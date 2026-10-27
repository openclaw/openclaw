import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, useContext } from "solid-js";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { ImageFrame } from "./chat-image-frame.tsx";
import { openMessageImage } from "./chat-message-image-open.ts";
import {
  createMessageImagePresentation,
  isInlineImageSource,
  type MessageImageProps,
} from "./chat-message-images-solid.tsx";
import { isCanonicalInboundMediaSource } from "./chat-message-local-media.ts";
import type { ImageBlock, ImageRenderOptions, MessageMediaAction } from "./chat-message-media.ts";

export type MessageImagesProps = {
  images: ImageBlock[];
  options?: ImageRenderOptions;
  previews?: JSX.Element[];
};

export function MessageImages(props: MessageImagesProps): JSX.Element {
  let slots: { image: ImageBlock; key: symbol; options: ImageRenderOptions }[] = [];
  let scope = "";
  let policyKey: string | undefined;
  let canonicalMessageKey: string | undefined;
  let localSubmission = false;
  const projection = createMemo(() => {
    const images = props.images;
    const options = props.options;
    const nextScope = JSON.stringify([
      options?.connectionEpoch,
      options?.authToken?.trim(),
      options?.resourceBasePath,
      options?.sessionKey,
      options?.agentId,
    ]);
    const continuing =
      scope === nextScope &&
      (!localSubmission || options?.localSubmission !== false) &&
      (canonicalMessageKey === options?.canonicalMessageKey ||
        (localSubmission && !canonicalMessageKey));
    const nextLocalSubmission = continuing ? localSubmission : options?.localSubmission === true;
    const adoptingSlots =
      continuing &&
      nextLocalSubmission &&
      images.length === slots.length &&
      slots.every(({ image }) => isInlineImageSource(image.url)) &&
      images.every((image) => image.factIndex !== undefined);
    const previousImages = adoptingSlots
      ? images.toSorted((left, right) => (left.factIndex ?? 0) - (right.factIndex ?? 0))
      : slots.map(({ image }) => image);
    const previousSlots = new Map(
      previousImages.map((image, index) => [image.factIndex, slots[index]?.key]),
    );
    // Publish options with the slot key so retiring images keep their previous policy.
    const imageOptions = { ...options, galleryImages: options?.galleryImages ?? images };
    slots = images.map((image, index) => {
      const slot = slots[index];
      const previous =
        image.factIndex !== undefined
          ? previousSlots.get(image.factIndex)
          : slot?.image.factIndex === undefined
            ? slot?.key
            : undefined;
      const preservePresentation =
        policyKey === options?.policyKey ||
        isInlineImageSource(image.url) ||
        (image.url !== undefined && isCanonicalInboundMediaSource(image.url));
      return {
        image,
        key: (continuing && preservePresentation && previous) || Symbol("image-slot"),
        options: imageOptions,
      };
    });
    scope = nextScope;
    policyKey = options?.policyKey;
    canonicalMessageKey = options?.canonicalMessageKey;
    localSubmission =
      nextLocalSubmission &&
      !(options?.canonicalMessageKey && images.every((image) => image.factIndex !== undefined));
    return slots;
  });
  const count = () => props.images.length + (props.previews?.length ?? 0);
  return (
    <Show when={count()}>
      <div
        class={[
          "chat-message-images",
          {
            "chat-message-images--single": count() === 1,
            "chat-message-images--gallery": count() !== 1,
            "chat-message-images--two-column": count() === 2 || count() === 4,
            "chat-message-images--five": count() === 5,
          },
        ]}
      >
        <For each={projection()} keyed={(slot) => slot.key}>
          {(slot) => <MessageImage image={slot().image} options={slot().options} />}
        </For>
        {props.previews}
      </div>
    </Show>
  );
}

function MessageImage(props: MessageImageProps): JSX.Element {
  const presented = useContext(ContentPresentation);
  // Parked content releases active image subscriptions.
  return (
    <Show when={presented()}>
      <MessageImageContent image={props.image} options={props.options} />
    </Show>
  );
}

function MessageImageContent(props: MessageImageProps): JSX.Element {
  const view = createMessageImagePresentation(props);
  return (
    <Show when={view.model().key} keyed>
      {(_key) => <ImageFrame model={view.model()} presentation={view} options={props.options} />}
    </Show>
  );
}

/** Catalogs consume the same admitted image resource and viewer as transcript tiles. */
type MessageImageActionProps = MessageImageProps & {
  render: (action: () => MessageMediaAction) => JSX.Element;
};
export function MessageImageAction(props: MessageImageActionProps): JSX.Element {
  // Match the transcript slot's retirement when its scope or policy changes.
  const scope = () =>
    JSON.stringify([
      props.options.sessionKey,
      props.options.agentId,
      props.options.connectionEpoch,
      props.options.resourceBasePath,
      props.options.authToken,
      props.options.policyKey,
      props.options.canonicalMessageKey,
    ]);
  return (
    <Show when={scope()} keyed>
      {(_scope) => {
        const presentation = createMessageImagePresentation(props);
        const action = createMemo<MessageMediaAction>(() => {
          const { actions, state, reason, previewUrl } = presentation.model();
          return {
            ...actions,
            pending: state === "loading",
            reason,
            observeElement: presentation.observeFrame,
            onFocus: state === "unavailable" ? undefined : presentation.admit,
            onOpen: previewUrl
              ? () => openMessageImage(props.image, previewUrl, props.options)
              : undefined,
          };
        });
        return props.render(action);
      }}
    </Show>
  );
}
