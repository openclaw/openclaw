import { createSignal, Errored, For, Loading, Show } from "solid-js";
import { ErrorDetails } from "../../components/config-error.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsLoadingSkeleton, SettingsPage } from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createPendingFocus } from "../../lib/reactive/pending-focus.ts";
import "../../styles/chat/text.css";
import "../../styles/carapace-control-ui.css";
import "../../styles/plugins.css";
import "../../styles/skill-workshop.css";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { PluginsHubHeader } from "../plugins/plugins-hub-header.tsx";
import { PLUGINS_HUB_PANEL_ID, pluginsHubPanel } from "../plugins/plugins-hub.ts";
import { Detail } from "./detail.tsx";
import { DraftDetail } from "./draft-detail.tsx";
import { LearningControl } from "./learning-control.tsx";
import { StartPage } from "./start-page.tsx";
import type { WorkshopPage, WorkshopView, WorkshopReads } from "./view-shared.tsx";
export type {
  WorkshopFilter,
  WorkshopSort,
  WorkshopStartView,
  WorkshopTab,
  WorkshopViewer,
  WorkshopViewerTarget,
} from "./view-shared.tsx";

registerEnglishCatalog(registerSkillWorkshopEnglish);

export function SkillWorkshopView(props: { view: WorkshopView; reads: WorkshopReads }) {
  // Turning the plugin on replaces the focused button with the Workshop; keep focus in the panel.
  createPendingFocus(
    () => {
      const plugin = props.view().plugin;
      return plugin?.status === "off" && plugin.enabling
        ? "enabling"
        : (plugin?.status ?? "loaded");
    },
    {
      requested: (next, previous) => previous === "enabling" && next === "loaded",
      focus: () => {
        const panel = document.getElementById(PLUGINS_HUB_PANEL_ID);
        if (panel && (!document.activeElement || document.activeElement === document.body)) {
          panel.tabIndex = -1;
          panel.focus({ preventScroll: true });
        }
      },
    },
  );
  // The list is the start page; a skill or draft opens as its own page, named in the URL so
  // Back returns to the list and a reload keeps the page.
  let panel: HTMLElement | undefined;
  const page: WorkshopPage = {
    // A row low in a long list opens its page from the top; the breadcrumb back is already there.
    open: () => {
      props.view().onOpenPage();
      panel?.scrollIntoView({ block: "start", behavior: resolveScrollBehavior("auto") });
    },
    close: () => props.view().onClosePage(),
  };
  // Keep the search on detail navigation, scoped to the agent's own skill library.
  const [search, setSearch] = createSignal<{ agentId: string | null; query: string } | null>(null);
  const query = () => {
    const current = search();
    return current && current.agentId === props.view().agentId ? current.query : "";
  };
  const setQuery = (value: string) => setSearch({ agentId: props.view().agentId, query: value });
  // Without a selection (the last draft was discarded, another agent was picked) the list shows.
  const detail = () =>
    props.view().pageOpen && !props.view().plugin && props.view().snapshot && props.view().viewer;
  return (
    <>
      <Show when={!detail()}>
        <PluginsHubHeader
          active="skill-workshop"
          class="sw-hub-header"
          onSelect={(tab) => props.view().context.navigate(tab)}
          actions={
            <Show when={!props.view().plugin}>
              <LearningControl view={props.view} />
            </Show>
          }
        />
      </Show>
      <SettingsWorkspace>
        <div
          {...pluginsHubPanel("skill-workshop")}
          ref={(element: HTMLElement) => {
            panel = element;
          }}
        >
          <SettingsPage wide carapace>
            <Show when={!props.view().plugin} fallback={<PluginUnavailable view={props.view} />}>
              <Show
                when={detail()}
                fallback={
                  <>
                    <PageErrors view={props.view} />
                    <Loading
                      on={props.reads.listRequest()}
                      fallback={!props.view().snapshot && <SettingsLoadingSkeleton carapace />}
                    >
                      <Errored
                        fallback={(error, reset) => (
                          <ErrorBanner
                            message={`${t("skillWorkshop.loadError")} ${formatUiError(error())}`}
                            onRetry={() => {
                              props.view().onRetry();
                              reset();
                            }}
                          />
                        )}
                      >
                        {props.reads.list() && null}
                      </Errored>
                    </Loading>
                    <Show when={props.view().snapshot}>
                      <StartPage
                        view={props.view}
                        reads={props.reads}
                        page={page}
                        query={query()}
                        onQuery={setQuery}
                      />
                    </Show>
                  </>
                }
              >
                <Show
                  when={props.view().viewer?.target.draftId}
                  fallback={
                    <Detail
                      view={props.view}
                      reads={props.reads}
                      page={page}
                      errors={<PageErrors view={props.view} />}
                    />
                  }
                >
                  <DraftDetail
                    view={props.view}
                    reads={props.reads}
                    page={page}
                    errors={<PageErrors view={props.view} />}
                  />
                </Show>
              </Show>
            </Show>
          </SettingsPage>
        </div>
      </SettingsWorkspace>
    </>
  );
}

function PageErrors(props: { view: WorkshopView }) {
  return (
    <>
      <For
        each={[props.view().learningError, props.view().modeError, props.view().actionError].filter(
          Boolean,
        )}
      >
        {(message) => <ErrorBanner message={message ?? ""} />}
      </For>
      {props.view().error && (
        <ErrorBanner
          message={`${t("skillWorkshop.loadError")} ${props.view().error}`}
          onRetry={props.view().onRetry}
        />
      )}
    </>
  );
}

/** The Gateway serves no Workshop methods: explain why, and turn the plugin on when allowed. */
function PluginUnavailable(props: { view: WorkshopView }) {
  const state = () => props.view().plugin;
  const off = () => {
    const current = state();
    return current?.status === "off" ? current : undefined;
  };
  const failure = () => {
    const current = state();
    return current?.status === "error" ? current : undefined;
  };
  const message = () => {
    const status = state()?.status;
    return status === "missing"
      ? t("skillWorkshop.plugin.missing")
      : status === "failed"
        ? t("skillWorkshop.plugin.failed")
        : status === "reload"
          ? t("skillWorkshop.plugin.reload")
          : props.view().pluginsDisabled
            ? t("skillWorkshop.plugin.pluginsDisabled")
            : props.view().access.canEnablePlugin
              ? t("skillWorkshop.plugin.offBody")
              : t("skillWorkshop.plugin.needsAdmin");
  };
  return (
    <Show when={state()?.status !== "checking"} fallback={<SettingsLoadingSkeleton carapace />}>
      <Show
        when={failure()}
        fallback={
          <div class="sw-empty sw-plugin-off oc-settings-group settings-group">
            <span class="sw-empty__icon" aria-hidden="true">
              <Icon name="wandSparkles" />
            </span>
            <Show when={off()}>
              <strong class="sw-empty__title">{t("skillWorkshop.plugin.offTitle")}</strong>
            </Show>
            <p>{message()}</p>
            <Show when={off()}>
              {(current) => (
                <Show when={props.view().access.canEnablePlugin && !props.view().pluginsDisabled}>
                  {/* aria-disabled keeps focus on the button while the Gateway works. */}
                  <button
                    type="button"
                    class="btn primary"
                    aria-disabled={current().enabling ? "true" : undefined}
                    aria-busy={current().enabling ? "true" : undefined}
                    onClick={() => props.view().onEnablePlugin()}
                  >
                    {current().enabling
                      ? t("skillWorkshop.plugin.enabling")
                      : t("skillWorkshop.plugin.enable")}
                  </button>
                </Show>
              )}
            </Show>
            <Show when={state()?.status === "reload"}>
              <button type="button" class="btn primary" onClick={() => location.reload()}>
                {t("common.reload")}
              </button>
            </Show>
            <Show when={off()?.error} keyed>
              {(error) => (
                <ErrorBanner message={t("skillWorkshop.plugin.enableFailed")} error={error} />
              )}
            </Show>
          </div>
        }
      >
        {(current) => (
          <ErrorBanner
            message={t("skillWorkshop.plugin.checkFailed")}
            error={current().error}
            onRetry={props.view().onRetryPlugin}
          />
        )}
      </Show>
    </Show>
  );
}

function ErrorBanner(props: { message: string; error?: unknown; onRetry?: () => void }) {
  return (
    <InlineAlert
      tone="danger"
      action={
        props.onRetry && (
          <button type="button" class="btn btn--sm" onClick={() => props.onRetry?.()}>
            {t("skillWorkshop.retry")}
          </button>
        )
      }
    >
      {props.message}
      {props.error != null && <ErrorDetails error={props.error} />}
    </InlineAlert>
  );
}
