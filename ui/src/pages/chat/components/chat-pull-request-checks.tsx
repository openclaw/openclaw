import type { JSX } from "@solidjs/web";
import { createEffect, createUniqueId, onCleanup, onSettled } from "solid-js";
import { createOverlayAnchor } from "../../../components/overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../../../components/overlay-lifecycle.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/solid/overlay.css";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import { t } from "../../../lib/reactive/i18n.ts";

export function ChatPullRequestChecks(props: {
  label: string;
  showLabel?: boolean;
  checksState: string;
  presented: boolean;
  dismissed?: boolean;
  children: JSX.Element;
}) {
  let details!: HTMLDetailsElement;
  let trigger!: HTMLElement;
  let surface!: HTMLElement;
  let mounted = false;
  const overlay = createOverlay(`chat-pr-checks-${createUniqueId()}`, undefined, {
    interactionElements: () => [details],
    // Keyboard session switching preserves the retained disclosure's open intent.
    dismissOutsideFocus: false,
    acquireOcclusion: acquireNativeOverlaySurface,
  });
  onCleanup(() => overlay.dispose());
  const sync = () => {
    if (mounted) {
      // Explicit Details dismissal clears intent; parking only hides the surface.
      if (props.dismissed) {
        details.open = false;
      }
      overlay.request(props.presented && details.open);
    }
  };
  // Synchronize the native disclosure with the pane presentation and overlay owner.
  createEffect(() => [props.presented, props.dismissed], sync);
  onSettled(() => {
    overlay.bindSurface(surface);
    overlay.bindTrigger(trigger);
    overlay.setParent(findOverlayParent(trigger));
    const anchor = createOverlayAnchor(surface);
    anchor.update(trigger, "top-end");
    // Apply each native close edge synchronously; parking preserves disclosure intent.
    const stop = overlay.subscribe((open) => {
      if (props.presented) {
        details.open = open;
      }
    });
    mounted = true;
    sync();
    return () => {
      mounted = false;
      stop();
      anchor.dispose();
    };
  });
  return (
    <details
      ref={(node) => (details = node)}
      class="chat-pr__checks"
      data-checks={props.checksState}
      onToggle={sync}
    >
      <summary
        ref={(node) => (trigger = node)}
        class="chat-pr__checks-pill"
        aria-label={props.label}
        title={props.label}
      >
        <span class="chat-pr__checks-dot" aria-hidden="true" />
        {props.showLabel ? props.label : t("chat.pullRequests.checks")}
        <span class="chat-pr__checks-chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </summary>
      <div
        ref={(node) => (surface = node)}
        class="oc-overlay chat-pr__checks-overlay"
        data-anchored-overlay
        popover="manual"
      >
        {props.children}
      </div>
    </details>
  );
}
