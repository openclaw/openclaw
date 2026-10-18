import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onSettled, Show, untrack } from "solid-js";

/** Retains only the exiting DOM; expansion and directory data remain with the workspace. */
export function FolderDisclosure(props: {
  open: boolean;
  active: boolean;
  instant: boolean;
  children: JSX.Element;
}) {
  const [present, setPresent] = createSignal(untrack(() => props.open));
  let shell!: HTMLDivElement;
  let content!: HTMLDivElement;
  let animation: Animation | undefined;
  let resizeFrame = 0;
  let targetHeight = 0;
  let ready = false;
  let current = { open: untrack(() => props.open), active: false, instant: true };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finish = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
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
  createEffect(
    () => ({ open: props.open, active: props.active, instant: props.instant }),
    (next) => {
      const from = shell.hidden ? 0 : shell.getBoundingClientRect().height;
      const opacity = shell.hidden ? 0 : Number(getComputedStyle(shell).opacity);
      current = next;
      shell.hidden = false;
      if (next.open) {
        setPresent(true);
      }
      move(from, opacity);
    },
  );
  onSettled(() => {
    ready = true;
    const motionChanged = () => {
      if (reducedMotion.matches) {
        finish();
      }
    };
    reducedMotion.addEventListener("change", motionChanged);
    // A lazy directory response may change the destination during its reveal.
    const observer = new ResizeObserver(() => {
      if (!animation || !current.open || resizeFrame) {
        return;
      }
      // Resize the ancestor after observer delivery, avoiding a browser layout loop.
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (animation && current.open && content.getBoundingClientRect().height !== targetHeight) {
          move(shell.getBoundingClientRect().height, Number(getComputedStyle(shell).opacity));
        }
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      animation?.cancel();
      reducedMotion.removeEventListener("change", motionChanged);
    };
  });
  return (
    <div
      ref={(element) => {
        shell = element;
        shell.hidden = !untrack(() => props.open);
      }}
      class="workspace-desktop__disclosure"
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
