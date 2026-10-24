import { lazy, onSettled, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { showToast } from "../lib/toast.ts";
import { LightboxAction } from "./image-lightbox-view.tsx";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import { Icon } from "./solid/icon.tsx";

const ComparisonDialog = lazy(() => import("./image-comparison-dialog.tsx"), {
  export: "ImageComparison",
});

export function ImageComparisonAction(props: {
  image: Pick<ImageLightboxItem, "readOriginalBlob">;
  title: string;
  focusableRef: () => (element: HTMLElement) => void;
  disabled: boolean;
}) {
  const lifetime = new AbortController();
  onSettled(() => () => lifetime.abort());
  let comparing = false;
  const compare = async () => {
    const read = props.image.readOriginalBlob;
    if (comparing || !read || props.disabled || lifetime.signal.aborted) {
      return;
    }
    const title = props.title;
    comparing = true;
    try {
      const { showImageComparison } = await ComparisonDialog.preload();
      await showImageComparison(read, title, lifetime.signal);
    } catch {
      if (!lifetime.signal.aborted) {
        showToast({ message: t("chat.imageLightbox.loadFailed"), severity: "error" });
      }
    } finally {
      comparing = false;
    }
  };
  return (
    <Show when={props.image.readOriginalBlob}>
      <LightboxAction
        focusableRef={props.focusableRef}
        class="zoom-control"
        label="chat.imageLightbox.compare"
        disabled={props.disabled}
        action={() => void compare()}
      >
        <Icon name="image" />
      </LightboxAction>
    </Show>
  );
}
