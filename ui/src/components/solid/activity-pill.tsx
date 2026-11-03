import type { JSX } from "@solidjs/web";
import { children, onSettled, Show } from "solid-js";
import { elementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { observeIntersection } from "../../lib/reactive/observers.ts";
import { createScrollStateRef } from "../../lib/reactive/scroll-state.ts";
import { iconData } from "../icon-data.ts";
import { BrandIcon, Icon, type IconName } from "./icon.tsx";
type Tone = "normal" | "muted" | "ok" | "warn" | "danger" | "purple";
type Glyph = string;
type Badge = { icon: Glyph; tone: Tone; label: string };
export type PillView = {
  label: string;
  icon: Glyph;
  tone?: Tone;
  badge?: Badge;
  attention?: boolean;
  shine?: boolean;
  count?: string;
  description?: string;
};

export function ActivityGlyph(props: { name: Glyph }) {
  const nativeName = () => {
    const name = props.name;
    return name === "goal" ||
      name === "pause" ||
      name === "bot" ||
      name === "filledStop" ||
      name === "spinner" ||
      name === "github"
      ? undefined
      : Object.hasOwn(iconData, name)
        ? (name as IconName)
        : "plug";
  };
  return (
    <Show when={props.name !== "spinner"} fallback={<span class="activity-pill__spinner" />}>
      <Show when={props.name !== "github"} fallback={<BrandIcon name="github" />}>
        <Show
          when={
            props.name === "goal" ||
            props.name === "pause" ||
            props.name === "bot" ||
            props.name === "filledStop"
          }
          fallback={<Show when={nativeName()}>{(name) => <Icon name={name()} />}</Show>}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <Show when={props.name === "goal"}>
              <path d="M12 13V2l8 4-8 4M20.561 10.222a9 9 0 1 1-12.55-5.29M8.002 9.997a5 5 0 1 0 8.9 2.02" />
            </Show>
            <Show when={props.name === "pause"}>
              <path d="M9 5v14M15 5v14" />
            </Show>
            <Show when={props.name === "bot"}>
              <rect x="4" y="7" width="16" height="13" rx="2" />
              <path d="M12 3v4M9 12v3m6-3v3M1 11v5m22-5v5" />
            </Show>
            <Show when={props.name === "filledStop"}>
              <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" stroke="none" />
            </Show>
          </svg>
        </Show>
      </Show>
    </Show>
  );
}

export function ActivityPill(props: {
  family: string;
  view: PillView;
  onOpen: (source: HTMLButtonElement) => void;
  registerButton: (button: HTMLButtonElement) => () => void;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  flow?: boolean;
}) {
  const leading = children(() => props.leading);
  let button!: HTMLButtonElement;
  const labelRef = createScrollStateRef(
    (element, state) => element.toggleAttribute("data-overflow", state.scrollable),
    { horizontal: true, trackScroll: false, content: () => props.view.label },
  );
  const accessibleLabel = () =>
    props.view.description ??
    (props.view.badge
      ? t("chat.activityPills.withBadge", {
          label: props.view.label,
          badge: props.view.badge.label,
        })
      : props.view.label);
  onSettled(() =>
    observeIntersection([button], ([entry]) =>
      button.toggleAttribute("data-out-of-view", !entry?.isIntersecting),
    ),
  );
  return (
    <button
      ref={[
        (element) => {
          button = element;
        },
        elementRef<HTMLButtonElement>((element) => props.registerButton(element)),
      ]}
      class={[
        "activity-pill",
        { "activity-pill--attention": props.view.attention, "activity-pill--flow": props.flow },
      ]}
      data-family={props.family}
      data-tone={props.view.tone ?? "normal"}
      data-counted={props.view.count ? "true" : "false"}
      type="button"
      aria-haspopup="dialog"
      aria-label={accessibleLabel()}
      title={accessibleLabel()}
      onClick={(event) => props.onOpen(event.currentTarget)}
    >
      <Show when={props.flow}>
        <span class="activity-pill__flow" aria-hidden="true">
          <span class="activity-pill__atlas" />
        </span>
      </Show>
      <Show
        when={leading()}
        fallback={
          <span class="activity-pill__leading" aria-hidden="true">
            <span class="activity-pill__composite">
              <ActivityGlyph name={props.view.icon} />
              <Show when={props.view.badge}>
                {(badge) => (
                  <span class="activity-pill__badge" data-tone={badge().tone}>
                    <ActivityGlyph name={badge().icon} />
                  </span>
                )}
              </Show>
            </span>
          </span>
        }
      >
        {leading()}
      </Show>
      <span ref={labelRef} class={["activity-pill__label", { "text-shimmer": props.view.shine }]}>
        {props.view.label}
      </span>
      <Show when={props.view.count}>
        {(count) => <span class="activity-pill__count">{count()}</span>}
      </Show>
      {props.trailing}
    </button>
  );
}
