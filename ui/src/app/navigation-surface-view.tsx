import { Errored, lazy, Loading, Show } from "solid-js";
import type { SidebarAttentionElementAttributes } from "../components/sidebar-attention-element.ts";
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
        {/* Old builds can lose the lazy card and its CSS, so recovery uses entry styles only. */}
        <Errored
          fallback={
            <section
              class="callout info callout--action"
              role="status"
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
            >
              <div class="callout__content">
                <strong>{t("connection.reload-required")}</strong>
                <div>{t("lazyView.staleSubtitle")}</div>
              </div>
              <button type="button" class="btn btn--sm" onClick={() => void props.onRefresh()}>
                {t("common.reload")}
              </button>
            </section>
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
