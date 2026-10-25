import type { JSX } from "@solidjs/web";
import {
  createMemo,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Show,
  onSettled,
  type Accessor,
} from "solid-js";
import type { ArtifactSummary } from "../../../../../packages/gateway-protocol/src/schema/artifacts.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { PanelEmptyState } from "../../../components/solid/panel-empty-state.tsx";
import { registerChatOutputsEnglish } from "../../../i18n/locales/en-chat-outputs.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { observeResize } from "../../../lib/reactive/observers.ts";
import {
  hasChatDesktopOutputs,
  type ChatOutputsDashboard,
  type ChatOutputsDesktopProps,
  type ChatOutputsProps,
} from "./chat-outputs-data.ts";
import "./chat-outputs.css";

registerEnglishCatalog(registerChatOutputsEnglish);

function OutputName(props: { text: string }) {
  let viewport!: HTMLSpanElement;
  let content!: HTMLSpanElement;
  onSettled(() => {
    const measure = () => {
      viewport.toggleAttribute("data-overflow", content.scrollWidth > viewport.clientWidth);
    };
    // Observe both boxes: font/text changes can overflow without resizing the row.
    const stopResize = observeResize([viewport, content], measure);
    measure();
    return stopResize;
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

function ArtifactReadSlot(props: {
  outputs: ChatOutputsProps;
  children: (
    artifacts: Accessor<readonly ArtifactSummary[] | null>,
    pending: Accessor<boolean>,
  ) => JSX.Element;
}) {
  const result = createMemo(() => ({ pending: props.outputs.artifactRead?.readResult }), {
    equals: (previous, next) => previous.pending === next.pending,
  });
  const source = createMemo(() => props.outputs.artifactRead);
  const snapshot = createMemo(() => props.outputs.artifacts);
  const error = createMemo(() => props.outputs.artifactsError);
  const read = createMemo(async () => {
    const owner = source();
    const pending = result().pending;
    const artifacts = snapshot();
    const previousError = error();
    await pending;
    const message = owner?.error ?? previousError;
    if (message) {
      throw new Error(message);
    }
    return owner?.resolved ? owner.items : artifacts;
  });
  return (
    <Loading
      on={source()}
      fallback={<OutputReadStatus pending error={null} label={t("outputs.loading")} />}
    >
      {props.children(
        () => props.outputs.artifacts,
        () => isPending(read),
      )}
      <Errored
        fallback={(failure, reset) => (
          <OutputReadStatus
            pending={false}
            error={formatUiError(failure())}
            label=""
            onRetry={() => {
              props.outputs.onRetryArtifacts?.();
              reset();
            }}
          />
        )}
      >
        <OutputReadStatus
          pending={isPending(read) || latest(read) === null}
          error={null}
          label={latest(read) === null ? t("outputs.loading") : t("outputs.updating")}
        />
      </Errored>
    </Loading>
  );
}

function DashboardStatus(props: ChatOutputsProps) {
  const result = createMemo(() => ({ pending: props.dashboardRead }), {
    equals: (previous, next) => previous.pending === next.pending,
  });
  const dashboard = createMemo(() => props.dashboard);
  const error = createMemo(() => props.dashboardError);
  const read = createMemo(async () => {
    const pending = result().pending;
    const value = dashboard();
    const failure = error();
    if (value === undefined && !failure) {
      await pending;
    }
    if (failure) {
      throw new Error(failure);
    }
    return value;
  });
  return (
    <Errored
      fallback={(failure, reset) => (
        <OutputReadStatus
          pending={false}
          error={formatUiError(failure())}
          label=""
          onRetry={
            props.onRetryDashboard
              ? () => {
                  props.onRetryDashboard?.();
                  reset();
                }
              : undefined
          }
        />
      )}
    >
      <Loading
        on={result()}
        fallback={<OutputReadStatus pending error={null} label={t("outputs.loadingDashboard")} />}
      >
        <OutputReadStatus
          pending={isPending(read) || latest(read) === undefined}
          error={null}
          label={t("outputs.loadingDashboard")}
        />
      </Loading>
    </Errored>
  );
}

/** Content of the desktop Details controlled Outputs disclosure, not a second section owner. */
export function ChatOutputsDesktop(props: ChatOutputsDesktopProps) {
  return (
    <Show when={hasChatDesktopOutputs(props)}>
      <div class="chat-outputs chat-outputs--desktop">
        <Show when={props.dashboard}>
          {(dashboard) => <DashboardRow dashboard={dashboard()} />}
        </Show>
        <ArtifactReadSlot outputs={props}>
          {(artifacts) => (
            <>
              <For
                each={(artifacts() ?? []).slice(0, props.dashboard ? 3 : 4)}
                keyed={(artifact) => artifact.id}
              >
                {(artifact) => <ArtifactRow artifact={artifact()} outputs={props} />}
              </For>
              <Show when={(artifacts()?.length ?? 0) + (props.dashboard ? 1 : 0) > 4}>
                <button
                  type="button"
                  class="chat-outputs__row chat-outputs__view-all"
                  onClick={() => props.onViewAll()}
                >
                  <span class="chat-outputs__icon">{props.renderViewAllIcon()}</span>
                  <span>{t("outputs.viewAll")}</span>
                </button>
              </Show>
            </>
          )}
        </ArtifactReadSlot>
        <DashboardStatus {...props} />
      </div>
    </Show>
  );
}

/** Body of the mobile Details Outputs child route; the host owns Back, size and area changes. */
export function ChatOutputsMobile(props: ChatOutputsProps) {
  return (
    <div class="chat-outputs chat-outputs--mobile">
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
      <ArtifactReadSlot outputs={props}>
        {(artifacts, pending) => (
          <>
            <Show when={artifacts()?.length}>
              <section class="chat-outputs__section" aria-label={t("outputs.files")}>
                <h3>{t("outputs.files")}</h3>
                <div class="chat-outputs__group">
                  <For each={artifacts() ?? []} keyed={(artifact) => artifact.id}>
                    {(artifact) => <ArtifactRow artifact={artifact()} outputs={props} mobile />}
                  </For>
                </div>
              </section>
            </Show>
            <Show
              when={
                !pending() &&
                artifacts()?.length === 0 &&
                props.dashboard === null &&
                !props.artifactsError &&
                !props.dashboardError
              }
            >
              <PanelEmptyState
                presentation="mobile"
                icon={<Icon name="fileText" />}
                heading={t("outputs.emptyTitle")}
                description={t("outputs.emptyDescription")}
              />
            </Show>
          </>
        )}
      </ArtifactReadSlot>
      <DashboardStatus {...props} />
    </div>
  );
}
