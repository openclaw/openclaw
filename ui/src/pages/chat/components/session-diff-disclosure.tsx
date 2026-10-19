import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onSettled, Show, untrack } from "solid-js";
import { listen } from "../../../lib/reactive/listener.ts";

/** Keeps the real reader present through exit; disclosure state belongs to the caller. */
export function ReviewDisclosure(props: {
  open: boolean;
  active: boolean;
  instant: boolean;
  children: JSX.Element;
}) {
  // Parent scroll restoration needs the initial content height before child effects run.
  const initialOpen = untrack(() => props.open);
  const [present, setPresent] = createSignal(initialOpen);
  let shell!: HTMLDivElement;
  let content!: HTMLDivElement;
  let animation: Animation | undefined;
  let current = { open: initialOpen, active: false, instant: true };
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
  createEffect(
    () => ({ open: props.open, active: props.active, instant: props.instant }),
    (next) => {
      const from = shell.hidden ? 0 : shell.getBoundingClientRect().height;
      current = next;
      shell.hidden = false;
      if (next.open) {
        setPresent(true);
      }
      move(from, next.open ? content.getBoundingClientRect().height : 0);
    },
  );
  onSettled(() => {
    ready = true;
    const motionChanged = () => {
      if (reducedMotion.matches) {
        finish();
      }
    };
    const stopMotion = listen(reducedMotion, "change", motionChanged);
    const observer = new ResizeObserver(() => {
      if (!current.open || !current.active) {
        return;
      }
      const next = content.getBoundingClientRect().height;
      if (next === height) {
        return;
      }
      // Context expansion and late syntax/layout changes retain the same reader.
      move(animation ? shell.getBoundingClientRect().height : height, next);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      animation?.cancel();
      stopMotion();
    };
  });
  return (
    <div
      ref={(element) => {
        shell = element;
        shell.hidden = !initialOpen;
      }}
      class="session-diff__disclosure"
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
