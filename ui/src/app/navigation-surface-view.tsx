import { dynamic } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import type { SidebarAttentionElementAttributes } from "../components/sidebar-attention-element.ts";
import type { SidebarUpdateCard } from "../components/sidebar-update-card.tsx";
import type { ApplicationContext } from "./context.ts";
import { floatingSidebarAttentionVisible } from "./navigation-surface.ts";
import { isStaleChunkImportError, scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

type FloatingUpdateCardProps = {
  navigationSurfaceHidden: boolean;
  mobileNavLayout: boolean;
  onboarding: boolean;
  compact?: boolean;
  updateRun?: ApplicationContext["overlays"]["snapshot"]["updateRun"];
  statusBanner?: ApplicationContext["overlays"]["snapshot"]["updateStatusBanner"];
  refreshRequired: boolean;
  onRefresh: () => Promise<boolean>;
  onNavigate?: ApplicationContext["navigate"];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-sidebar-attention": SidebarAttentionElementAttributes;
    }
  }
}

export function FloatingUpdateCard(props: FloatingUpdateCardProps) {
  return (
    <>
      <Show when={floatingSidebarAttentionVisible(props)}>
        <openclaw-sidebar-attention
          class="sidebar-attention--floating"
          prop:onNavigate={props.onNavigate}
        />
      </Show>
      <Show when={!props.compact && props.refreshRequired}>
        {(_refreshRequired) => {
          const [card, setCard] = createSignal<typeof SidebarUpdateCard>();
          const Card = dynamic(card);
          onSettled(() => {
            void import("../components/sidebar-update-card.tsx")
              .then((module) => setCard(() => module.SidebarUpdateCard))
              .catch((error: unknown) => {
                if (isStaleChunkImportError(error)) {
                  void scheduleStaleChunkReload();
                }
              });
          });
          return (
            <Card
              class="sidebar-update-card--floating"
              updateRun={props.updateRun ?? null}
              statusBanner={props.statusBanner ?? null}
              refreshRequired={props.refreshRequired}
              onRefresh={props.onRefresh}
            />
          );
        }}
      </Show>
    </>
  );
}
