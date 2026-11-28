import { createUniqueId, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover } from "../../components/solid/popover.tsx";
import { LearnMoreLink, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { PLUGINS_HUB_DOCS_URLS } from "../plugins/plugins-hub.ts";
import type { SkillWorkshopMode } from "./mode.ts";
import type { WorkshopView } from "./view-shared.tsx";

const MODES: readonly SkillWorkshopMode[] = ["off", "propose", "auto"];

/** The learning state reads as one sentence at the top right; the gear holds the mode and the learning session. */
export function LearningControl(props: { view: WorkshopView }) {
  const menuId = `sw-learning-${createUniqueId()}`;
  const learningTitle = () => {
    const access = props.view().learningAccess;
    return access.allowed ? t("skillWorkshop.learning.description") : access.reason;
  };
  return (
    <div class="sw-learning">
      <Show when={props.view().mode}>
        {(mode) => (
          <span class="sw-learning__state" title={t(`skillWorkshop.mode.${mode()}Title`)}>
            <span
              class={[
                "sw-learning__dot",
                // Propose still runs background reviews, so it shows learning as on.
                `sw-learning__dot--${mode() === "off" ? "off" : "auto"}`,
              ]}
              aria-hidden="true"
            />
            {t(`skillWorkshop.mode.${mode()}State`)}
          </span>
        )}
      </Show>
      <Popover
        id={menuId}
        label={t("skillWorkshop.mode.aria")}
        triggerClass="btn btn--sm btn--icon plugins-hub-header__secondary oc-action oc-action-secondary sw-learning__gear"
        triggerTitle={t("skillWorkshop.mode.aria")}
        trigger={<Icon name="settings" />}
        placement="bottom-end"
        class="sw-learning-menu"
      >
        <Show when={props.view().mode}>
          {(mode) => (
            <div class="sw-learning-menu__mode">
              <span class="sw-learning-menu__label">{t("skillWorkshop.mode.label")}</span>
              <SettingsSegmented
                mode="buttons"
                ariaLabel={t("skillWorkshop.mode.aria")}
                value={mode()}
                disabled={!props.view().access.canSetMode}
                saving={props.view().modeBusy}
                options={MODES.map((value) => ({ value, label: t(`skillWorkshop.mode.${value}`) }))}
                onChange={(nextMode) => props.view().onModeChange(nextMode)}
              />
              <p class="sw-learning-menu__hint">{t(`skillWorkshop.mode.${mode()}Title`)}</p>
            </div>
          )}
        </Show>
        <button
          type="button"
          class="sw-learning-menu__learn"
          title={learningTitle()}
          aria-labelledby={`${menuId}-learn`}
          aria-describedby={`${menuId}-learn-hint`}
          disabled={props.view().learningBusy || !props.view().learningAccess.allowed}
          onClick={() => props.view().onLearn()}
        >
          <span>
            <strong id={`${menuId}-learn`}>
              {props.view().learningBusy
                ? t("skillWorkshop.learning.starting")
                : t("skillWorkshop.learning.short")}
            </strong>
            <span id={`${menuId}-learn-hint`}>{t("skillWorkshop.learning.description")}</span>
          </span>
          <span aria-hidden="true">
            <Icon name="wandSparkles" />
          </span>
        </button>
        {/* On a phone the subtitle row holds the learning state, so its docs link moves here. */}
        <div class="sw-learning-menu__docs">
          <LearnMoreLink url={PLUGINS_HUB_DOCS_URLS["skill-workshop"]} />
        </div>
      </Popover>
    </div>
  );
}
