import { spread } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import type { BoardWidget } from "../../lib/board/types.ts";
import { createBoardSandboxFrame } from "../../lib/board/widget-sandbox-prewarm.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { BoardWidgetFrameOwner } from "./board-widget-frame.tsx";

export function BoardSandboxFrame(props: {
  state: () => BoardWidgetFrameOwner;
  current: () => BoardWidget;
  url: () => string;
  visible: () => boolean;
  painting: () => boolean;
}) {
  let container!: HTMLSpanElement;
  const [mounted, setMounted] = createSignal<HTMLIFrameElement>();
  onSettled(() => {
    const current = props.state();
    const url = props.url();
    const prepared = current.takePreparedSandbox(props.current(), url);
    const frame = prepared?.frame ?? createBoardSandboxFrame();
    current.bindFrame(frame, prepared?.host);
    if (prepared) {
      prepared.adopt(container);
    } else {
      frame.src = url;
      container.append(frame);
    }
    const release = current.frameConnected(frame);
    const stopLoad = listen(frame, "load", () => props.state().postBoardHostState(frame));
    const stopError = listen(frame, "error", () => props.state().handleFrameError(props.current()));
    const stopFocus = listen(frame, "openclaw:restore-focus", (event) =>
      props.state().restoreFocus(event),
    );
    setMounted(frame);
    return () => {
      release();
      stopLoad();
      stopError();
      stopFocus();
    };
  });
  return (
    <span
      ref={(element) => {
        container = element;
      }}
      style={{ display: "contents" }}
    >
      <Show when={mounted()} keyed>
        {(frame) => {
          spread(
            frame,
            () => ({
              style: { opacity: props.visible() || props.painting() ? undefined : 0 },
              inert: !props.visible(),
              title: props.current().title || props.current().name,
            }),
            true,
          );
          return null;
        }}
      </Show>
    </span>
  );
}
