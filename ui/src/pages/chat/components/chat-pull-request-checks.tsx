import type { JSX } from "@solidjs/web";
import { createEffect, createUniqueId, onCleanup, onSettled, untrack, useContext } from "solid-js";
import { createOverlayAnchor } from "../../../components/overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../../../components/overlay-lifecycle.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/solid/overlay.css";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import { PRESENTATION_CHANGED_EVENT, type PresentationValue } from "../../../lib/presentation.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";

export function ChatPullRequestChecks(props: {
  label: string;
  showLabel?: boolean;
  checksState: string;
  presented: PresentationValue;
  dismissed?: boolean;
  children: JSX.Element;
}) {
  let details!: HTMLDetailsElement;
  let trigger!: HTMLElement;
  let surface!: HTMLElement;
  let mounted = false;
  const parentPresented = useContext(ContentPresentation);
  const presented = () => {
    const value = props.presented;
    return parentPresented() && (typeof value === "boolean" ? value : value.isPresented());
  };
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
      overlay.request(presented() && details.open);
    }
  };
  createEffect(
    () => [props.presented, parentPresented(), props.dismissed] as const,
    ([value]) => {
      sync();
      if (typeof value === "boolean") {
        return undefined;
      }
      value.owner.addEventListener(PRESENTATION_CHANGED_EVENT, sync);
      return () => value.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, sync);
    },
  );
  onSettled(() => {
    overlay.bindSurface(surface);
    overlay.bindTrigger(trigger);
    overlay.setParent(findOverlayParent(trigger));
    const anchor = createOverlayAnchor(surface);
    anchor.update(trigger, "top-end");
    // Parking hides the native surface while preserving disclosure intent.
    const stop = overlay.subscribe((open) => {
      if (untrack(presented)) {
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
      ref={(node) => {
        details = node;
      }}
      class="chat-pr__checks"
      data-checks={props.checksState}
      onToggle={sync}
    >
      <summary
        ref={(node) => {
          trigger = node;
        }}
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
        ref={(node) => {
          surface = node;
        }}
        class="oc-overlay chat-pr__checks-overlay"
        data-anchored-overlay
        popover="manual"
      >
        {props.children}
      </div>
    </details>
  );
}
