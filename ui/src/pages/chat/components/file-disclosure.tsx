import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { listen } from "../../../lib/reactive/listener.ts";

/** Retains exiting file content; disclosure state and data remain with the caller. */
export function FileDisclosure(props: {
  variant: "folder" | "review";
  open: boolean;
  active: boolean;
  instant: boolean;
  children: JSX.Element;
}) {
  // Render initially open content synchronously and retain it through exit.
  const [present, setPresent] = createSignal<boolean>(
    (previous) => props.open || previous || false,
  );
  let shell!: HTMLDivElement;
  let content!: HTMLDivElement;
  let animation: Animation | undefined;
  let current = { open: false, active: false, instant: true };
  let applied: typeof current | undefined;
  let height = 0;
  let ready = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const folder = () => props.variant === "folder";
  const finish = () => {
    animation?.cancel();
    animation = undefined;
    shell.hidden = !current.open;
    shell.style.height = "";
    shell.style.overflow = "";
    setPresent(current.open);
  };
  function move(from: number, to?: number, opacity = 1) {
    animation?.cancel();
    animation = undefined;
    // Folder content is measured after revealing/cancelling; Review supplies its settled target.
    const destination = to ?? (current.open ? content.getBoundingClientRect().height : 0);
    height = destination;
    if (
      !ready ||
      !current.active ||
      current.instant ||
      reducedMotion.matches ||
      from === destination
    ) {
      finish();
      return;
    }
    shell.style.height = `${destination}px`;
    shell.style.overflow = "clip";
    animation = shell.animate(
      folder()
        ? [
            { height: `${from}px`, opacity },
            { height: `${destination}px`, opacity: current.open ? 1 : 0 },
          ]
        : [{ height: `${from}px` }, { height: `${destination}px` }],
      folder()
        ? { duration: 200, easing: getComputedStyle(shell).getPropertyValue("--ease-out").trim() }
        : { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    );
    animation.onfinish = finish;
  }
  createLayoutMeasurement(
    () => ({ open: props.open, active: props.active, instant: props.instant }),
    (next) => {
      if (!next) {
        return undefined;
      }
      if (next === applied) {
        if (folder()) {
          if (!animation || !current.open || content.getBoundingClientRect().height === height) {
            return undefined;
          }
        } else {
          if (!current.open || !current.active) {
            return undefined;
          }
          const to = content.getBoundingClientRect().height;
          if (to === height) {
            return undefined;
          }
          const from = animation ? shell.getBoundingClientRect().height : height;
          return () => move(from, to);
        }
      }
      const closed = !current.open && !animation;
      const from = closed || shell.hidden ? 0 : shell.getBoundingClientRect().height;
      const opacity =
        folder() && !closed && !shell.hidden ? Number(getComputedStyle(shell).opacity) : 0;
      return () => {
        applied = next;
        current = next;
        shell.hidden = false;
        move(
          from,
          folder() ? undefined : next.open ? content.getBoundingClientRect().height : 0,
          opacity,
        );
      };
    },
    { targets: () => [content], changeTiming: "sync" },
  );
  onSettled(() => {
    ready = true;
    const motionChanged = () => {
      if (reducedMotion.matches) {
        finish();
      }
    };
    const stopMotion = listen(reducedMotion, "change", motionChanged);
    return () => {
      animation?.cancel();
      stopMotion();
    };
  });
  return (
    <div
      ref={(element) => {
        shell = element;
      }}
      class={folder() ? "workspace-desktop__disclosure" : "session-diff__disclosure"}
      hidden={!present()}
      inert={!props.open || !props.active}
      aria-hidden={props.open ? "false" : "true"}
    >
      <div
        ref={(element) => {
          content = element;
        }}
      >
        <Show when={props.open || present()}>{props.children}</Show>
      </div>
    </div>
  );
}
