import { html, nothing } from "lit";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode } from "../../api/types.ts";
import {
  renderSettingsNavRow,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { BASE_THINKING_LEVELS } from "../../lib/chat/thinking.ts";
import { GENERAL_SETTINGS_TARGET_IDS } from "./settings-targets.ts";

type QuickModelSectionProps = {
  currentModel: string;
  modelCatalogMode?: "replace";
  thinkingLevel: string;
  fastMode: FastMode | undefined;
  onModelChange?: () => void;
  onThinkingChange?: (level: string) => void;
  onFastModeChange?: (mode: FastMode) => void;
  configLoading?: boolean;
  configSaving?: boolean;
  configApplying?: boolean;
  configUpdating?: boolean;
};

// The compact General hub intentionally omits "minimal"; the full list stays
// available on session-level pickers.
const THINKING_LEVELS = BASE_THINKING_LEVELS.filter((level) => level !== "minimal");

function fastModeOptionValue(value: "auto" | "on" | "off"): FastMode {
  return value === "auto" ? "auto" : value === "on";
}

function isConfigBusy(props: QuickModelSectionProps): boolean {
  return (
    props.configLoading === true ||
    props.configSaving === true ||
    props.configApplying === true ||
    props.configUpdating === true
  );
}

export function renderModelSection(props: QuickModelSectionProps) {
  const fastMode = formatFastModeValue(props.fastMode);
  const configBusy = isConfigBusy(props);
  const rows = [
    renderSettingsNavRow({
      title: t("quickSettings.model.model"),
      control: renderSettingsValue(props.currentModel || "default", { mono: true }),
      onClick: () => props.onModelChange?.(),
    }),
    props.modelCatalogMode === "replace"
      ? renderSettingsRow({
          title: t("chat.selectors.replaceModeHint"),
          control: html`
            <button type="button" class="btn" @click=${() => props.onModelChange?.()}>
              ${t("chat.selectors.manageModels")}
            </button>
          `,
        })
      : nothing,
    renderSettingsRow({
      title: t("quickSettings.model.thinking"),
      control: renderSettingsSegmented({
        value: props.thinkingLevel,
        options: THINKING_LEVELS.map((level) => ({
          value: level,
          label: t(`quickSettings.model.thinkingLevels.${level}`),
        })),
        disabled: configBusy,
        onChange: (level) => props.onThinkingChange?.(level),
      }),
    }),
    renderSettingsRow({
      title: t("quickSettings.model.fastMode"),
      control: renderSettingsSegmented<"auto" | "on" | "off">({
        value: fastMode,
        options: [
          { value: "auto", label: t("quickSettings.model.fastModes.auto") },
          { value: "on", label: t("quickSettings.model.fastModes.fast") },
          { value: "off", label: t("quickSettings.model.fastModes.standard") },
        ],
        disabled: configBusy,
        onChange: (value) => {
          if (value !== fastMode) {
            props.onFastModeChange?.(fastModeOptionValue(value));
          }
        },
      }),
    }),
  ];
  return html`<div id=${GENERAL_SETTINGS_TARGET_IDS.model}>
    ${renderSettingsSection({ title: t("quickSettings.model.title") }, rows)}
  </div>`;
}
