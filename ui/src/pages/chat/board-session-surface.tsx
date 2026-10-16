import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { createEffect, createSignal, Show } from "solid-js";
import { PanelLoadingSkeleton } from "../../components/solid/panel-loading-skeleton.tsx";
import type { BoardViewCallbacks } from "../../lib/board/provider.ts";
import type { BoardSnapshot } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  PRESENTATION_CHANGED_EVENT,
  type PresentationValue,
} from "../../lit/presentation-binding.ts";

export type BoardSessionSurfaceProps = {
  active: PresentationValue;
  session: BoardGetParams;
  snapshot: BoardSnapshot | undefined;
  activeTabId: string;
  pageWidgetName?: string;
  canMutate: boolean;
  canGrant: boolean;
  callbacks: BoardViewCallbacks;
  widgetFrameUrl: BoardWidgetFrameUrl;
};

let boardViewLoad: Promise<unknown> | null = null;

export async function ensureBoardViewElement(): Promise<boolean> {
  if (customElements.get("openclaw-board-view")) {
    return false;
  }
  boardViewLoad ??= import("../../components/board/board-view.ts");
  await boardViewLoad;
  return true;
}

export function BoardSessionSurface(props: BoardSessionSurfaceProps & { elementReady?: boolean }) {
  const [revision, setRevision] = createSignal(0);
  createEffect(
    () => props.active,
    (binding) => {
      if (typeof binding === "boolean") {
        return undefined;
      }
      const changed = () => {
        // Reveals wait for the parent's new props unless navigation explicitly previews the retained board.
        if (!binding.isPresented() || binding.preview?.()) {
          setRevision((value) => value + 1);
        }
      };
      binding.owner.addEventListener(PRESENTATION_CHANGED_EVENT, changed);
      return () => binding.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, changed);
    },
  );
  const active = () => {
    revision();
    return typeof props.active === "boolean" ? props.active : props.active.isPresented();
  };
  return (
    <div class="board-session-surface" hidden={!active()} inert={!active()}>
      <div class="board-session-surface__board">
        <openclaw-board-view
          prop:active={active()}
          prop:session={props.session}
          prop:snapshot={props.snapshot}
          prop:activeTabId={props.activeTabId}
          prop:pageWidgetName={props.pageWidgetName ?? ""}
          prop:widgetFrameUrl={props.widgetFrameUrl}
          prop:callbacks={props.callbacks}
          prop:canMutate={props.canMutate}
          prop:canGrant={props.canGrant}
        />
        <Show when={!(props.elementReady ?? Boolean(customElements.get("openclaw-board-view")))}>
          <PanelLoadingSkeleton variant="board" label={t("common.loading")} overlay />
        </Show>
      </div>
    </div>
  );
}
