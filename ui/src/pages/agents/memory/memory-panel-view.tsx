import { createMemo, latest } from "solid-js";
import { SettingsDefaultDescription } from "../../../components/solid/settings-ui.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { AgentMemoryState } from "./memory-panel-state.ts";
import { renderDreamingToggleConfirmation as DreamingToggleConfirmation } from "./toggle-confirmation.tsx";
import { renderDreaming as Dreaming } from "./view.tsx";

export function AgentMemoryView(props: { state: AgentMemoryState }) {
  const model = createMemo(() => props.state.view());
  // Interrupted/confirmed receipts remain visible while a retired action is still pending.
  const diaryOutcome = () => latest(() => props.state.diaryOutcome());
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
              role="switch"
              aria-checked={model().header.dreamingOn ? "true" : "false"}
              aria-label={t("dreaming.header.toggle")}
              class={[
                "dreams__phase-toggle",
                { "dreams__phase-toggle--on": model().header.dreamingOn },
              ]}
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
      <Dreaming
        {...model().dreaming}
        configOpening={props.state.configOpening()}
        dreamDiaryActionLoading={props.state.diaryActionBusy()}
        dreamDiaryActionMessage={diaryOutcome().message}
        dreamDiaryActionArchivePath={diaryOutcome().archivePath}
      />
      <DreamingToggleConfirmation {...model().toggle} />
    </>
  );
}
