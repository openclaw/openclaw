import { createMemo, untrack } from "solid-js";
import { SettingsDefaultDescription } from "../../../components/solid/settings-ui.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import type { AgentMemoryState } from "./memory-panel-state.ts";
import { renderDreamingToggleConfirmation as DreamingToggleConfirmation } from "./toggle-confirmation.tsx";
import { renderDreaming as Dreaming } from "./view.tsx";

export function AgentMemoryView(props: { state: AgentMemoryState }) {
  const state = untrack(() => props.state);
  const projection = projectSource(state, {
    read: (owner) => owner,
    subscribe: (owner, notify) => owner.subscribe(notify),
    equality: "revision",
  });
  const model = createMemo(() => projection.read().view);
  // The owner mutates this view-only state synchronously. Reads subscribe to its
  // revision while writes keep the same owner object and request boundary.
  const viewState = new Proxy(state.view.dreaming.viewState, {
    get(target, key, receiver) {
      projection.revision();
      return Reflect.get(target, key, receiver);
    },
  });
  return (
    <>
      <section class="content-header content-header--page agent-memory-panel__header">
        <div class="page-meta">
          <div class="dreaming-header-controls">
            <button
              class="btn btn--subtle btn--sm"
              disabled={model().header.loading || model().dreaming.dreamDiaryLoading}
              onClick={() => void props.state.loadResources("all", true)}
            >
              {model().header.refreshLoading
                ? t("dreaming.header.refreshing")
                : t("dreaming.header.refresh")}
            </button>
            <span class="muted">
              {model().header.configuredDreaming.engineOff ? (
                t("dreaming.header.engineOff")
              ) : (
                <SettingsDefaultDescription
                  value={t("common.enabled")}
                  overridden={model().header.configuredDreaming.overridden}
                />
              )}
            </span>
            <button
              class={`dreams__phase-toggle ${model().header.dreamingOn ? "dreams__phase-toggle--on" : ""}`}
              disabled={
                !model().header.canUpdateConfig ||
                model().header.loading ||
                model().header.configuredDreaming.engineOff
              }
              onClick={() => props.state.setEnabled(!model().header.dreamingOn)}
            >
              <span class="dreams__phase-toggle-dot"></span>
              <span class="dreams__phase-toggle-label">
                {model().header.dreamingOn ? t("dreaming.header.on") : t("dreaming.header.off")}
              </span>
            </button>
          </div>
        </div>
      </section>
      <Dreaming {...model().dreaming} viewState={viewState} />
      <DreamingToggleConfirmation {...model().toggle} />
    </>
  );
}
