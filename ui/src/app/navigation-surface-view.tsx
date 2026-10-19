import { onSettled, Show } from "solid-js";
import type { SidebarAttentionElementAttributes } from "../components/sidebar-attention-element.ts";
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
      "openclaw-sidebar-update-card": HTMLAttributes<HTMLElement> & {
        "prop:updateRun": FloatingUpdateCardProps["updateRun"];
        "prop:statusBanner": FloatingUpdateCardProps["statusBanner"];
        "prop:refreshRequired": FloatingUpdateCardProps["refreshRequired"];
        "prop:onRefresh": FloatingUpdateCardProps["onRefresh"];
      };
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
          onSettled(() => {
            void import("../components/sidebar-update-card.tsx").catch((error: unknown) => {
              if (isStaleChunkImportError(error)) {
                void scheduleStaleChunkReload();
              }
            });
          });
          return (
            <openclaw-sidebar-update-card
              class="sidebar-update-card--floating"
              prop:updateRun={props.updateRun ?? null}
              prop:statusBanner={props.statusBanner ?? null}
              prop:refreshRequired={props.refreshRequired}
              prop:onRefresh={props.onRefresh}
            />
          );
        }}
      </Show>
    </>
  );
}
