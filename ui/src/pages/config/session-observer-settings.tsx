import { createMemo } from "solid-js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { dedupeByKey } from "../../../../src/shared/dedupe-by-key.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import { SettingsRow, SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatCompletionRoute } from "../../lib/model-runtime-label.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import type { SessionObserverModelSelection } from "./session-observer-settings.ts";

registerEnglishCatalog(registerSettingsEnglish);

const AUTO_VALUE = "__openclaw_observer_auto__";

function resolvedModelLabel(status: SystemInfoResult["defaultAgentUtilityModel"]): string {
  if (!status || status.status === "unavailable") {
    return t("configView.sessionObserver.modelUnavailable");
  }
  if (status.status === "disabled") {
    return t("configView.sessionObserver.modelDisabled");
  }
  const runtime = formatCompletionRoute(status.runtime)?.label;
  return t(
    status.status === "auto"
      ? "configView.sessionObserver.modelAuto"
      : "configView.sessionObserver.modelConfigured",
    { model: runtime ? `${status.model} · ${runtime}` : status.model },
  );
}

function modelOptions(models: readonly ModelCatalogEntry[]) {
  return dedupeByKey(
    models
      .filter((model) => model.available !== false)
      .map((model) => ({
        value: model.id.startsWith(`${model.provider}/`)
          ? model.id
          : `${model.provider}/${model.id}`,
        label: model.name || model.id,
        provider: model.provider,
      })),
    (model) => model.value,
  ).toSorted((a, b) => a.label.localeCompare(b.label));
}

type SessionObserverSettingsProps = {
  enabled: boolean;
  utilityModel: string | undefined;
  resolvedUtilityModel: SystemInfoResult["defaultAgentUtilityModel"];
  models: readonly ModelCatalogEntry[];
  modelsUnavailable: boolean;
  disabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onUtilityModelChange: (selection: SessionObserverModelSelection) => void;
};

export function SessionObserverSettings(props: SessionObserverSettingsProps) {
  const selected = () => (props.utilityModel === undefined ? AUTO_VALUE : props.utilityModel);
  const options = createMemo(() => {
    const catalog = modelOptions(props.models);
    const result = [
      { value: AUTO_VALUE, label: t("configView.sessionObserver.auto") },
      { value: "", label: t("configView.sessionObserver.disabled") },
      ...(selected() !== AUTO_VALUE &&
      selected() !== "" &&
      !catalog.some((option) => option.value === selected())
        ? [{ value: selected(), label: selected(), disabled: props.modelsUnavailable }]
        : []),
      ...catalog.map((option) => Object.assign({}, option, { disabled: props.modelsUnavailable })),
    ];
    return result;
  });
  return (
    <div class="settings-group">
      <SettingsToggleRow
        title={t("configView.sessionObserver.toggle")}
        description={t("configView.sessionObserver.toggleHint")}
        checked={props.enabled}
        disabled={props.disabled}
        onChange={props.onEnabledChange}
      />
      <SettingsRow
        title={t("configView.sessionObserver.resolvedModel")}
        description={resolvedModelLabel(props.resolvedUtilityModel)}
      />
      <SettingsRow
        title={t("configView.sessionObserver.modelPicker")}
        description={t(
          props.modelsUnavailable
            ? "configView.sessionObserver.modelCatalogUnavailable"
            : "configView.sessionObserver.modelPickerHint",
        )}
        control={
          <ModelPicker
            label={t("configView.sessionObserver.modelPicker")}
            value={selected()}
            options={options()}
            disabled={props.disabled}
            onChange={(value) =>
              props.onUtilityModelChange(
                value === AUTO_VALUE
                  ? { kind: "auto" }
                  : value === ""
                    ? { kind: "disabled" }
                    : { kind: "model", model: value },
              )
            }
          />
        }
      />
    </div>
  );
}
