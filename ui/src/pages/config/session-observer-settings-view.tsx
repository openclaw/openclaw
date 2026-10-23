import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  createSignal,
  Errored,
  latest,
  Loading,
  refresh,
  Show,
} from "solid-js";
import { dedupeByKey } from "../../../../src/shared/dedupe-by-key.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import { SettingsRow, SettingsToggleRow } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { formatCompletionRoute } from "../../lib/model-runtime-label.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionObserverModelSelection } from "./session-observer-settings.ts";
import type { ConfigProps } from "./view-types.ts";

const AUTO_VALUE = "__openclaw_observer_auto__";

function resolvedModelLabel(status: ConfigProps["sessionObserverResolvedModel"]): string {
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

export function SessionObserverSettings(props: { config: ConfigProps }) {
  const lifetime = createMemo(() => ({ retired: props.config.presentationRetired() }), {
    equals: (previous, next) => previous.retired === next.retired,
  });
  const modelsScope = createMemo(() => props.config.sessionObserverModelsScope);
  const presentation = createMemo(() => {
    const { retired } = lifetime();
    const [values, setValues] = createOptimisticStore(() => ({
      enabled: props.config.sessionObserverEnabled !== false,
      model: props.config.sessionObserverUtilityModel,
      resolved: props.config.sessionObserverResolvedModel,
    }));
    const [saving, setSaving] = createOptimistic(false);
    return { retired, values, setValues, saving, setSaving };
  });
  const [completion, setCompletion] = createSignal<Promise<void> | null>(null);
  const outcome = createMemo(async () => {
    await completion();
    return null;
  });
  type Edit = { enabled: boolean } | { model: SessionObserverModelSelection };
  const current = (view: ReturnType<typeof presentation>) =>
    view.retired === props.config.presentationRetired();
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<boolean>,
    retired: Promise<void>,
    edit: Edit,
  ) {
    try {
      if (current(view)) {
        view.setSaving(true);
        view.setValues((draft) => {
          if ("enabled" in edit) {
            draft.enabled = edit.enabled;
          } else {
            draft.model =
              edit.model.kind === "auto"
                ? undefined
                : edit.model.kind === "disabled"
                  ? ""
                  : edit.model.model;
          }
        });
        if ("model" in edit) {
          affects(view.values, "resolved");
        }
      }
      yield Promise.race([pending, retired]);
      if (current(view)) {
        yield refresh(view.values);
      }
    } catch (error) {
      if (current(view)) {
        throw error;
      }
    }
  });
  function submit(edit: Edit) {
    if (props.config.sessionObserverDisabled) {
      return;
    }
    const view = presentation();
    const retired = props.config.presentationRetired();
    const pending =
      "enabled" in edit
        ? props.config.setSessionObserverEnabled?.(edit.enabled)
        : props.config.setSessionObserverUtilityModel?.(edit.model);
    if (!pending) {
      return;
    }
    // Admission publishes owner facts before the optimistic transition joins this tick.
    void setCompletion(Promise.resolve().then(() => present(view, pending, retired, edit)));
  }
  const disabled = () => presentation().saving() || props.config.sessionObserverDisabled === true;
  return (
    <>
      <div class="settings-section__header settings-section__header--subsection">
        <h3 class="settings-section__heading">{t("configView.sessionObserver.title")}</h3>
      </div>
      <p class="settings-section__desc">{t("configView.sessionObserver.hint")}</p>
      <div class="settings-group">
        <SettingsToggleRow
          title={t("configView.sessionObserver.toggle")}
          description={t("configView.sessionObserver.toggleHint")}
          checked={presentation().values.enabled}
          disabled={disabled()}
          onChange={(enabled) => submit({ enabled })}
        />
        <Loading>
          <SettingsRow
            title={t("configView.sessionObserver.resolvedModel")}
            description={resolvedModelLabel(latest(() => presentation().values.resolved))}
          />
        </Loading>
        <Errored
          fallback={(_error) => (
            <SessionObserverModelPicker
              value={presentation().values.model}
              disabled={disabled()}
              onChange={(model) => submit({ model })}
              models={[]}
              unavailable
            />
          )}
        >
          <Loading
            on={modelsScope()}
            fallback={
              <SessionObserverModelPicker
                value={presentation().values.model}
                disabled={disabled()}
                onChange={(model) => submit({ model })}
                models={[]}
                unavailable={props.config.sessionObserverModelsUnavailable === true}
              />
            }
          >
            <SessionObserverModelPicker
              value={presentation().values.model}
              disabled={disabled()}
              onChange={(model) => submit({ model })}
              models={props.config.sessionObserverModels ?? []}
              unavailable={props.config.sessionObserverModelsUnavailable === true}
            />
          </Loading>
        </Errored>
      </div>
      <Show when={presentation().saving()}>
        <p role="status">{t("common.saving")}</p>
      </Show>
      <Show when={!presentation().saving()}>
        <Errored fallback={(error) => <p role="alert">{formatUiError(error())}</p>}>
          <Loading>{outcome()}</Loading>
        </Errored>
      </Show>
    </>
  );
}

function SessionObserverModelPicker(props: {
  value: string | undefined;
  disabled: boolean;
  onChange: (selection: SessionObserverModelSelection) => void;
  models: readonly ModelCatalogEntry[];
  unavailable: boolean;
}) {
  const selected = () => (props.value === undefined ? AUTO_VALUE : props.value);
  const options = createMemo(() => {
    const catalog = modelOptions(props.models);
    const result = [
      { value: AUTO_VALUE, label: t("configView.sessionObserver.auto") },
      { value: "", label: t("configView.sessionObserver.disabled") },
      ...(selected() !== AUTO_VALUE &&
      selected() !== "" &&
      !catalog.some((option) => option.value === selected())
        ? [
            {
              value: selected(),
              label: selected(),
              disabled: props.unavailable,
            },
          ]
        : []),
      ...catalog.map((option) => Object.assign({}, option, { disabled: props.unavailable })),
    ];
    return result;
  });

  return (
    <SettingsRow
      title={t("configView.sessionObserver.modelPicker")}
      description={t(
        props.unavailable
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
            props.onChange(
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
  );
}
