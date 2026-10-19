import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import { listen } from "../../../lib/reactive/listener.ts";

/** Retains only the exiting DOM; expansion and directory data remain with the workspace. */
export function FolderDisclosure(props: {
  open: boolean;
  active: boolean;
  instant: boolean;
  children: JSX.Element;
}) {
  // Render an initially open folder synchronously and retain its children through exit.
  const [present, setPresent] = createSignal<boolean>(
    (previous) => props.open || previous || false,
  );
  let shell!: HTMLDivElement;
  let content!: HTMLDivElement;
  let animation: Animation | undefined;
  let targetHeight = 0;
  let ready = false;
  let current = { open: false, active: false, instant: true };
  let applied: typeof current | undefined;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finish = () => {
    animation?.cancel();
    animation = undefined;
    shell.hidden = !current.open;
    shell.style.height = "";
    shell.style.overflow = "";
    setPresent(current.open);
  };
  const move = (from: number, opacity: number) => {
    animation?.cancel();
    animation = undefined;
    const to = current.open ? content.getBoundingClientRect().height : 0;
    targetHeight = to;
    if (!ready || !current.active || current.instant || reducedMotion.matches || from === to) {
      finish();
      return;
    }
    shell.style.height = `${to}px`;
    shell.style.overflow = "clip";
    animation = shell.animate(
      [
        { height: `${from}px`, opacity },
        { height: `${to}px`, opacity: current.open ? 1 : 0 },
      ],
      { duration: 200, easing: getComputedStyle(shell).getPropertyValue("--ease-out").trim() },
    );
    animation.onfinish = finish;
  };
  createLayoutMeasurement(
    () => ({ open: props.open, active: props.active, instant: props.instant }),
    (next) => {
      if (!next) {
        return;
      }
      if (
        next === applied &&
        (!animation || !current.open || content.getBoundingClientRect().height === targetHeight)
      ) {
        return;
      }
      const closed = !current.open && !animation;
      const from = closed || shell.hidden ? 0 : shell.getBoundingClientRect().height;
      const opacity = closed || shell.hidden ? 0 : Number(getComputedStyle(shell).opacity);
      return () => {
        applied = next;
        current = next;
        shell.hidden = false;
        // A hidden folder has no measurable destination until it is revealed.
        move(from, opacity);
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
      class="workspace-desktop__disclosure"
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
