import { Errored, lazy, Loading, Show } from "solid-js";
import type { SidebarAttentionElementAttributes } from "../components/sidebar-attention-element.ts";
import { InlineAlert } from "../components/solid/inline-alert.tsx";
import { t } from "../lib/reactive/i18n.ts";
import { ShellComponentBoundary } from "./app-shell-component-boundary.tsx";
import type { ApplicationContext } from "./context.ts";
import { floatingSidebarAttentionVisible } from "./navigation-surface.ts";
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
      <Show when={!props.compact && props.refreshRequired}>
        {/* A Gateway replaced by a newer build no longer serves this tab's lazy card
            chunk or its stylesheet, so the fallback uses only entry modules and styles. */}
        <Errored
          fallback={
            <InlineAlert
              tone="info"
              title={t("connection.workspace.reload.title")}
              style={{
                position: "fixed",
                "z-index": 45,
                top: "calc(var(--safe-area-top, 0px) + 56px)",
                left: "50%",
                translate: "-50% 0",
                "max-width": "min(520px, calc(100vw - 24px))",
                background: "var(--popover)",
                "box-shadow": "var(--shadow-md)",
              }}
              action={
                <button type="button" class="btn btn--sm" onClick={() => void props.onRefresh()}>
                  {t("connection.workspace.reloadAction")}
                </button>
              }
            >
              {t("connection.workspace.reload.description")}
            </InlineAlert>
          }
        >
          <Loading>
            <UpdateCard
              class="sidebar-update-card--floating"
              updateRun={props.updateRun ?? null}
              statusBanner={props.statusBanner ?? null}
              refreshRequired={props.refreshRequired}
              onRefresh={props.onRefresh}
            />
          </Loading>
        </Errored>
      </Show>
    </>
  );
}
