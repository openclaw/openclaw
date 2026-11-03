import { Errored, lazy, Loading, Show } from "solid-js";
import type { SidebarAttentionElementAttributes } from "../components/sidebar-attention-element.ts";
import { t } from "../lib/reactive/i18n.ts";
import { ShellComponentBoundary } from "./app-shell-component-boundary.tsx";
import type { ApplicationContext } from "./context.ts";
import {
  floatingRefreshNoticeVisible,
  floatingSidebarAttentionVisible,
} from "./navigation-surface.ts";
import { isStaleChunkImportError, scheduleStaleChunkReload } from "./stale-chunk-reload.ts";

const UpdateCard = lazy(
  () =>
    import("../components/sidebar-update-card.tsx").catch((error: unknown) => {
      if (isStaleChunkImportError(error)) {
        void scheduleStaleChunkReload();
      }
      throw error;
    }),
  { export: "SidebarUpdateCard" },
);

const SidebarAttention = lazy(() => import("../components/sidebar-attention.tsx"), {
  export: "SidebarAttention",
});

type FloatingUpdateCardProps = {
  navigationSurfaceHidden: boolean;
  mobileNavLayout: boolean;
  onboarding: boolean;
  compact?: boolean;
  updateRun?: ApplicationContext["overlays"]["snapshot"]["updateRun"];
  statusBanner?: ApplicationContext["overlays"]["snapshot"]["updateStatusBanner"];
  refreshRequired: boolean;
  refreshInSidebar: boolean;
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
        <ShellComponentBoundary label={t("attention.issues")}>
          <SidebarAttention class="sidebar-attention--floating" onNavigate={props.onNavigate} />
        </ShellComponentBoundary>
      </Show>
      <Show when={floatingRefreshNoticeVisible(props)}>
        <ControlUiRefreshNotice
          placement="floating"
          updateRun={props.updateRun}
          statusBanner={props.statusBanner}
          onRefresh={props.onRefresh}
        />
      </Show>
    </>
  );
}

export type ControlUiRefreshNoticeProps = {
  placement: "sidebar" | "floating";
  updateRun?: ApplicationContext["overlays"]["snapshot"]["updateRun"];
  statusBanner?: ApplicationContext["overlays"]["snapshot"]["updateStatusBanner"];
  onRefresh: () => Promise<boolean>;
};

/** The server-updated notice; the sidebar hosts it when visible, otherwise it floats. */
export function ControlUiRefreshNotice(props: ControlUiRefreshNoticeProps) {
  return (
    <Errored fallback={null}>
      <Loading>
        <UpdateCard
          class={`refresh-notice-host--${props.placement}`}
          updateRun={props.updateRun ?? null}
          statusBanner={props.statusBanner ?? null}
          refreshRequired
          onRefresh={props.onRefresh}
        />
      </Loading>
    </Errored>
  );
}
