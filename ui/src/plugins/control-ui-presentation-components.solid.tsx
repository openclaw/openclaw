import { render } from "@solidjs/web";
import { createSignal, Errored, lazy, Loading, onSettled, type Component } from "solid-js";
import type { ControlUiComponentHandle } from "../../../src/plugin-sdk/control-ui-components.js";
import { listen } from "../lib/reactive/listener.ts";

const ContextMenu = lazy(() => import("./control-ui-context-menu.solid.tsx"));
const ToggleRow = lazy(() => import("./control-ui-toggle-row.solid.tsx"));

/** The SDK owns this foreign DOM island; Solid owns lazy loading and its render tree. */
export function createControlUiPresentationComponents(options: {
  assertCurrent: () => void;
  signal: AbortSignal;
  onError: (error: unknown) => void;
}) {
  function Failed(props: { error: unknown }) {
    onSettled(() => options.onError(props.error));
    return null;
  }
  function native<P extends object>(View: Component<P>) {
    return (container: HTMLElement, initial: P): ControlUiComponentHandle<P> => {
      options.assertCurrent();
      options.signal.throwIfAborted();
      const target = container.appendChild(document.createElement("div"));
      target.style.display = "contents";
      let active = true;
      let props = initial;
      let update: (value: P) => void = () => {};
      let stop = () => {};
      // The SDK may be called from a plugin's settled callback. Create the
      // foreign Solid root after that flush, but only while this handle lives.
      queueMicrotask(() => {
        if (!active || options.signal.aborted) {
          return;
        }
        try {
          options.assertCurrent();
          // A plugin may supply a portaled container outside the app root.
          // render owns event delegation there as well as the view's disposal.
          stop = render(() => {
            const [state, setState] = createSignal({ value: props });
            update = (value) => setState({ value });
            return (
              <Errored fallback={(error) => <Failed error={error()} />}>
                <Loading fallback={null}>
                  <View {...state().value} />
                </Loading>
              </Errored>
            );
          }, target);
        } catch (error) {
          dispose();
          options.onError(error);
        }
      });
      const dispose = () => {
        if (!active) {
          return;
        }
        active = false;
        stopAbort();
        stop();
        target.remove();
      };
      const stopAbort = listen(options.signal, "abort", dispose, { once: true });
      return {
        update(next) {
          options.assertCurrent();
          options.signal.throwIfAborted();
          if (!active) {
            throw new Error("This plugin component has ended.");
          }
          props = next;
          update(next);
        },
        dispose,
      };
    };
  }
  return { mountContextMenu: native(ContextMenu), mountToggleRow: native(ToggleRow) };
}
