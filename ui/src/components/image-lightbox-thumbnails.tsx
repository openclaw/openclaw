import { For, Loading, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../lib/reactive/observers.ts";
import { createScrollPosition } from "../lib/reactive/scroll-state.ts";
import type { ImageLightboxGallery } from "./image-lightbox.types.ts";

type Thumbnail = NonNullable<ImageLightboxGallery["thumbnails"]>[number];

export function LightboxThumbnails(props: {
  items: readonly Thumbnail[];
  index: number;
  busy: boolean;
  focusableRef: () => (element: HTMLElement) => void;
  onSelect: (index: number) => void;
}) {
  let region!: HTMLDivElement;
  const buttons: HTMLButtonElement[] = [];
  createScrollPosition(
    () => ({
      reveal: { identity: [props.items, props.index], target: () => buttons[props.index] },
    }),
    { region: () => region, revealAxis: "inline", revealTiming: "animation-frame" },
  );
  return (
    <div
      class="gallery-thumbnails"
      ref={(element) => {
        region = element;
      }}
      role="group"
      aria-label={t("chat.imageLightbox.thumbnails")}
    >
      <For each={props.items}>
        {(item, index) => (
          <button
            ref={[
              (element) => {
                buttons[index()] = element;
              },
              props.focusableRef(),
            ]}
            type="button"
            class="gallery-thumbnail"
            aria-label={t("chat.imageLightbox.thumbnail", {
              current: String(index() + 1),
              title: item.title,
            })}
            aria-current={index() === props.index ? "true" : undefined}
            aria-disabled={props.busy ? "true" : "false"}
            onClick={() => {
              if (!props.busy && index() !== props.index) {
                props.onSelect(index());
              }
            }}
          >
            <ThumbnailImage item={item} />
          </button>
        )}
      </For>
    </div>
  );
}

function ThumbnailImage(props: { item: Thumbnail }) {
  let frame!: HTMLSpanElement;
  const [visible, setVisible] = createSignal(false);
  createIntersectionObserver(
    () => [frame],
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
      }
    },
  );
  const preview = createMemo(async () => {
    if (!visible()) {
      return null;
    }
    const load = props.item.load;
    let retired = false;
    const pending = load().catch(() => null);
    onCleanup(() => {
      retired = true;
      void pending.then((item) => item?.release?.());
    });
    const item = await pending;
    if (retired) {
      return null;
    }
    return item;
  });
  return (
    <span
      class="gallery-thumbnail-image"
      ref={(element) => {
        frame = element;
      }}
    >
      <Loading>
        <Show when={preview()}>
          {(item) => <img src={item().src} alt="" decoding="async" referrerpolicy="no-referrer" />}
        </Show>
      </Loading>
    </span>
  );
}
