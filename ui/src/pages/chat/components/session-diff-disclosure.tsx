import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { listen } from "../../../lib/reactive/listener.ts";

/** Keeps the real reader present through exit; disclosure state belongs to the caller. */
export function ReviewDisclosure(props: {
  open: boolean;
  active: boolean;
  instant: boolean;
  children: JSX.Element;
}) {
  // Render an initially open reader synchronously and retain it through exit.
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
  const finish = () => {
    animation?.cancel();
    animation = undefined;
    shell.hidden = !current.open;
    shell.style.height = "";
    shell.style.overflow = "";
    setPresent(current.open);
  };
  function move(from: number, to: number) {
    animation?.cancel();
    animation = undefined;
    height = to;
    if (!ready || !current.active || current.instant || reducedMotion.matches || from === to) {
      finish();
      return;
    }
    shell.style.height = `${to}px`;
    shell.style.overflow = "clip";
    animation = shell.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 240,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    });
    animation.onfinish = finish;
  }
  createLayoutMeasurement(
    () => ({ open: props.open, active: props.active, instant: props.instant }),
    (next) => {
      if (!next) {
        return undefined;
      }
      if (next === applied) {
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
      const closed = !current.open && !animation;
      const from = closed || shell.hidden ? 0 : shell.getBoundingClientRect().height;
      return () => {
        applied = next;
        current = next;
        shell.hidden = false;
        // A hidden reader has no measurable destination until it is revealed.
        move(from, next.open ? content.getBoundingClientRect().height : 0);
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
      class="session-diff__disclosure"
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
