import { createSignal } from "solid-js";
import type { ControlUiNativeHost } from "../../../src/plugin-sdk/control-ui-native.js";
import { createOverlayAnchor } from "../components/overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../components/overlay-lifecycle.ts";
import { SessionGitDiff } from "../components/session-git-diff.tsx";
import { acquireNativeOverlaySurface } from "../lib/native-overlay-occlusion.ts";
import { listen } from "../lib/reactive/listener.ts";
import { mountSolidContent } from "../lib/reactive/mount-solid-content.ts";

export function createControlUiNativeHost(signal: AbortSignal): ControlUiNativeHost {
  const active = () => signal.throwIfAborted();
  const own = (dispose: () => void) => {
    let live = true;
    const stop = () => {
      if (!live) {
        return;
      }
      live = false;
      stopAbort();
      dispose();
    };
    const stopAbort = listen(signal, "abort", stop, { once: true });
    if (signal.aborted) {
      stop();
    }
    return stop;
  };
  return {
    mountDiff(container, initial) {
      const [props, setProps] = createSignal({ value: initial }, { ownedWrite: true });
      active();
      const stop = own(mountSolidContent(container, () => <SessionGitDiff {...props().value} />));
      return {
        update(value) {
          active();
          setProps({ value });
        },
        dispose: stop,
      };
    },
    createDisclosureOverlay(id, details) {
      active();
      const owner = createOverlay(id, undefined, {
        interactionElements: () => [details()],
        dismissOutsideFocus: false,
        acquireOcclusion: acquireNativeOverlaySurface,
      });
      const dispose = own(() => owner.dispose());
      return {
        bind(surface, trigger) {
          active();
          owner.bindSurface(surface);
          owner.bindTrigger(trigger);
          owner.setParent(findOverlayParent(trigger));
          const anchor = createOverlayAnchor(surface);
          anchor.update(trigger, "top-end");
          return own(() => anchor.dispose());
        },
        request: (open) => {
          active();
          owner.request(open);
        },
        subscribe: (notify) => {
          active();
          return own(owner.subscribe(notify));
        },
        dispose,
      };
    },
  };
}
