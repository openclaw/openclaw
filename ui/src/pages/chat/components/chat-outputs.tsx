import type { JSX } from "@solidjs/web";
import { For, Show, onSettled } from "solid-js";
import type { ArtifactSummary } from "../../../../../packages/gateway-protocol/src/schema/artifacts.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import "./chat-outputs.css";

type ChatOutputsDashboard = {
  title: string;
  onOpen: () => void;
};

type ChatOutputsData = {
  /** The complete artifacts.list({ sessionKey, messageRole: "assistant" }) result. */
  artifacts: readonly ArtifactSummary[] | null;
  artifactsLoading: boolean;
  artifactsError: string | null;
  /** undefined: not resolved; null: confirmed absent. Not one entry per widget. */
  dashboard: ChatOutputsDashboard | null | undefined;
  dashboardError: string | null;
};

type ChatOutputsProps = ChatOutputsData & {
  onOpenArtifact: (artifactId: ArtifactSummary["id"]) => void;
  onRetryArtifacts?: () => void;
  onRetryDashboard?: () => void;
  /** Use the original filename when the native owner has it; never infer an extension. */
  getArtifactName?: (artifact: ArtifactSummary) => string;
  /** Native icon owner supplies the document/table geometry for this artifact. */
  renderArtifactIcon: (artifact: ArtifactSummary) => JSX.Element;
};

export type ChatOutputsDesktopProps = ChatOutputsProps & {
  /** Select the existing Files catalog, even if a preview is currently active. */
  onViewAll: () => void;
  /** The approved Folders glyph, supplied by the shared icon owner. */
  renderViewAllIcon: () => JSX.Element;
};

/** Shared by the root entry and its interior; unknown is not a zero count. */
export function getChatOutputsCount(data: ChatOutputsData): number | null {
  if (data.artifacts === null || data.dashboard === undefined) {
    return null;
  }
  return data.artifacts.length + (data.dashboard === null ? 0 : 1);
}

/** Optional desktop sections need content or an actionable read error, not a speculative slot. */
export function hasChatDesktopOutputs(data: ChatOutputsData): boolean {
  return Boolean(
    data.artifacts?.length || data.dashboard || data.artifactsError || data.dashboardError,
  );
}

/** The explicit mobile destination distinguishes loading from confirmed absence. */
function isChatOutputsEmpty(data: ChatOutputsData): boolean {
  return (
    getChatOutputsCount(data) === 0 &&
    !data.artifactsLoading &&
    !data.artifactsError &&
    !data.dashboardError
  );
}

function OutputName(props: { text: string }) {
  let viewport!: HTMLSpanElement;
  let content!: HTMLSpanElement;
  onSettled(() => {
    const measure = () => {
      viewport.toggleAttribute("data-overflow", content.scrollWidth > viewport.clientWidth);
    };
    // Observe both boxes: font/text changes can overflow without resizing the row.
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  });
  return (
    <span class="chat-outputs__name" ref={(element) => (viewport = element)}>
      <span ref={(element) => (content = element)}>{props.text}</span>
    </span>
  );
}

function ArtifactRow(props: {
  artifact: ArtifactSummary;
  outputs: ChatOutputsProps;
  mobile?: boolean;
}) {
  const name = () => props.outputs.getArtifactName?.(props.artifact) ?? props.artifact.title;
  return (
    <button
      type="button"
      class="chat-outputs__row"
      onClick={() => props.outputs.onOpenArtifact(props.artifact.id)}
    >
      <span class="chat-outputs__icon">{props.outputs.renderArtifactIcon(props.artifact)}</span>
      <OutputName text={name()} />
      <Show when={props.mobile}>
        <Icon name="chevronRight" class="chat-outputs__chevron" />
      </Show>
    </button>
  );
}

function DashboardRow(props: { dashboard: ChatOutputsDashboard; mobile?: boolean }) {
  return (
    <button
      type="button"
      class="chat-outputs__row chat-outputs__row--dashboard"
      onClick={() => props.dashboard.onOpen()}
    >
      <span class="chat-outputs__icon">
        <Icon name={props.mobile ? "layoutGrid" : "layoutDashboard"} />
      </span>
      <OutputName text={props.dashboard.title} />
      <Show when={props.mobile}>
        <Icon name="chevronRight" class="chat-outputs__chevron" />
      </Show>
    </button>
  );
}

function OutputReadStatus(props: {
  pending: boolean;
  error: string | null;
  label: string;
  onRetry?: () => void;
}) {
  return (
    <>
      <Show when={props.error}>
        <div class="chat-outputs__status" role="status">
          <span>{props.error}</span>
          <Show when={props.onRetry}>
            <button type="button" disabled={props.pending} onClick={() => props.onRetry?.()}>
              {t("common.retry")}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.pending && !props.error}>
        <div class="chat-outputs__status" role="status">
          {props.label}
        </div>
      </Show>
    </>
  );
}

function OutputStatuses(props: ChatOutputsProps) {
  return (
    <>
      <OutputReadStatus
        pending={props.artifactsLoading || (props.artifacts === null && !props.artifactsError)}
        error={props.artifactsError}
        label={props.artifacts === null ? t("outputs.loading") : t("outputs.updating")}
        onRetry={props.onRetryArtifacts}
      />
      <OutputReadStatus
        pending={props.dashboard === undefined && !props.dashboardError}
        error={props.dashboardError}
        label={t("outputs.loadingDashboard")}
        onRetry={props.onRetryDashboard}
      />
    </>
  );
}

/** Content of the desktop Details controlled Outputs disclosure, not a second section owner. */
export function ChatOutputsDesktop(props: ChatOutputsDesktopProps) {
  const visibleArtifacts = () => (props.artifacts ?? []).slice(0, props.dashboard ? 3 : 4);
  const hasMore = () => (props.artifacts?.length ?? 0) + (props.dashboard ? 1 : 0) > 4;
  return (
    <Show when={hasChatDesktopOutputs(props)}>
      <div class="chat-outputs chat-outputs--desktop">
        <Show when={props.dashboard}>
          {(dashboard) => <DashboardRow dashboard={dashboard()} />}
        </Show>
        <For each={visibleArtifacts()} keyed={(artifact) => artifact.id}>
          {(artifact) => <ArtifactRow artifact={artifact()} outputs={props} />}
        </For>
        <Show when={hasMore()}>
          <button
            type="button"
            class="chat-outputs__row chat-outputs__view-all"
            onClick={() => props.onViewAll()}
          >
            <span class="chat-outputs__icon">{props.renderViewAllIcon()}</span>
            <span>{t("outputs.viewAll")}</span>
          </button>
        </Show>
        <OutputStatuses {...props} />
      </div>
    </Show>
  );
}

/** Body of the mobile Details Outputs child route; the host owns Back, size and area changes. */
export function ChatOutputsMobile(props: ChatOutputsProps) {
  return (
    <div class="chat-outputs chat-outputs--mobile">
      <Show
        when={!isChatOutputsEmpty(props)}
        fallback={
          <PanelEmptyState
            icon={<Icon name="fileText" />}
            heading={t("outputs.emptyTitle")}
            description={t("outputs.emptyDescription")}
          />
        }
      >
        <Show when={props.dashboard}>
          {(dashboard) => (
            <section class="chat-outputs__section" aria-label={t("tabs.dashboards")}>
              <h3>{t("tabs.dashboards")}</h3>
              <div class="chat-outputs__group">
                <DashboardRow dashboard={dashboard()} mobile />
              </div>
            </section>
          )}
        </Show>
        <Show when={props.artifacts?.length}>
          <section class="chat-outputs__section" aria-label={t("outputs.files")}>
            <h3>{t("outputs.files")}</h3>
            <div class="chat-outputs__group">
              <For each={props.artifacts ?? []} keyed={(artifact) => artifact.id}>
                {(artifact) => <ArtifactRow artifact={artifact()} outputs={props} mobile />}
              </For>
            </div>
          </section>
        </Show>
        <OutputStatuses {...props} />
      </Show>
    </div>
  );
}
