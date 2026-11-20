import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";

/** A skill's own mark: its image, else its emoji, else the default skill icon. */
export function SkillTile(props: {
  emoji?: string;
  imageUrl?: string;
  class?: JSX.HTMLAttributes<HTMLElement>["class"];
}) {
  return (
    <span
      class={[
        "skill-tile",
        props.class,
        { "skill-tile--default": !props.imageUrl && !props.emoji },
      ]}
      aria-hidden="true"
    >
      <Show
        when={props.imageUrl}
        fallback={
          <Show when={props.emoji} fallback={<Icon name="bookOpenText" />}>
            {props.emoji}
          </Show>
        }
      >
        {(url) => <img src={url()} alt="" loading="lazy" />}
      </Show>
    </span>
  );
}
