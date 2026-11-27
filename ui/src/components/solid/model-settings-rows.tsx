import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { dedupeByKey } from "../../../../src/shared/dedupe-by-key.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode, ModelCatalogEntry } from "../../api/types.ts";
import { isChatFastModeProviderSupported } from "../../lib/chat/model-select-state.ts";
import { thinkingLevelLabel } from "../../lib/chat/thinking-level-label.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { DecisionModelPicker, type DecisionModelPickerParams } from "./decision-model-picker.tsx";
import { Icon } from "./icon.tsx";
import { ModelPicker, type ModelPickerOption, type ModelPickerParams } from "./model-picker.tsx";
import { SettingsRow, SettingsSegmented } from "./settings-ui.tsx";
import "./model-settings-rows.css";

function HelpTitle(params: {
  title: string;
  label: string;
  triggerId: string;
  paragraphs: string[];
}) {
  return (
    <span class="model-providers__label-with-help">
      <span>{params.title}</span>
      <span class="settings-section__docs">
        <openclaw-tooltip open-on-click>
          <button
            id={params.triggerId}
            type="button"
            class="settings-section__help-button model-providers__help-button"
            aria-label={params.label}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Escape") {
                event.stopPropagation();
              }
            }}
          >
            <Icon name="circleQuestionMark" />
          </button>
          <div slot="content" class="settings-section__help-panel">
            <For each={params.paragraphs}>{(text) => <p>{text}</p>}</For>
          </div>
        </openclaw-tooltip>
      </span>
    </span>
  );
}

type Behavior<Value> = {
  value?: Value;
  defaultLabel?: string;
  overridden: boolean;
  disabled: boolean;
  saving?: boolean;
  onChange: (value: Value) => void;
  onReset: () => void;
};
function BehaviorSetting<Value extends string>(
  props: {
    field: "thinking" | "fastMode";
    prefix: string;
    defaultHelp: string;
    options: { value: Value; label: string; disabled?: boolean }[];
  } & Behavior<Value>,
) {
  return (
    <SettingsRow
      title={
        <HelpTitle
          title={t(`quickSettings.model.${props.field}`)}
          label={t(`modelProviders.defaults.${props.field}HelpLabel`)}
          triggerId={`${props.prefix}-${props.field === "thinking" ? "thinking" : "fast-mode"}-help`}
          paragraphs={[t(`modelProviders.defaults.${props.field}Help`), props.defaultHelp]}
        />
      }
      control={
        <SettingsSegmented<Value | "">
          value={props.value ?? ""}
          ariaLabel={t(`quickSettings.model.${props.field}`)}
          options={[
            { value: "" as const, label: props.defaultLabel ?? t("quickSettings.model.default") },
            ...props.options,
          ]}
          disabled={props.disabled}
          saving={props.saving}
          onChange={(value) => (value === "" ? props.onReset() : props.onChange(value))}
          onReselect={(value) => {
            if (value === "" && props.overridden) {
              props.onReset();
            }
          }}
        />
      }
    />
  );
}

export function speedLabel(value: FastMode) {
  if (value === "auto") {
    return t("quickSettings.model.fastModes.auto");
  }
  if (value === "ultrafast") {
    return t("chat.modelControls.ultrafast");
  }
  return t(value ? "chat.modelControls.fast" : "quickSettings.model.fastModes.off");
}
function speedOptions(model: ModelCatalogEntry | undefined, value: string | undefined) {
  const fast =
    model?.supportsFastMode ??
    (model?.available === true && isChatFastModeProviderSupported(model.provider));
  const ultrafast =
    fast && model?.available === true && model.serviceTiers?.includes("ultrafast") === true;
  return (["auto", true, "ultrafast", false] as const)
    .map((mode) => ({
      value: formatFastModeValue(mode),
      label: speedLabel(mode),
      disabled: mode === false ? false : mode === "ultrafast" ? !ultrafast : !fast,
    }))
    .filter((option) => !option.disabled || option.value === value);
}

const INHERIT_FALLBACK = "__openclaw_inherit_fallback__";
export type FallbackSetting = {
  fallbacks: string[];
  options: (ModelPickerOption & { model?: string })[];
  isExcluded: (model: string) => boolean;
  disabled: boolean;
  title?: string;
  inherit?: { selected: boolean; label: string; reset: () => void };
  chainEditor?: () => JSX.Element;
  onOpen?: () => void;
  onChange: (model: string | null) => void;
};
function FallbackModel(props: FallbackSetting & { label: string }) {
  const [editing, setEditing] = createSignal(false);
  const options = createMemo(() => [
    ...(props.inherit ? [{ value: INHERIT_FALLBACK, label: props.inherit.label }] : []),
    {
      value: "",
      label:
        props.fallbacks.length > 1
          ? t("modelProviders.defaults.clearFallbacks", { count: String(props.fallbacks.length) })
          : t("modelProviders.defaults.noFallback"),
    },
    ...props.options.filter((option) => !props.isExcluded(option.model ?? option.value)),
  ]);
  return (
    <SettingsRow
      title={props.label}
      description={
        props.fallbacks.length > 1 || props.chainEditor ? (
          <>
            {props.fallbacks.length > 1
              ? t(
                  props.fallbacks.length === 2
                    ? "modelProviders.defaults.moreFallbackOne"
                    : "modelProviders.defaults.moreFallbacks",
                  { count: String(props.fallbacks.length - 1) },
                )
              : undefined}
            <Show when={props.chainEditor}>
              <button
                type="button"
                class="model-settings__edit-chain"
                aria-expanded={editing() ? "true" : "false"}
                onClick={() => setEditing(!editing())}
              >
                {t("agents.overview.editFallbackChain")}
              </button>
            </Show>
          </>
        ) : undefined
      }
      control={
        <div class="model-settings__fallback-control">
          <ModelPicker
            windowed
            label={props.label}
            options={options()}
            value={props.inherit?.selected ? INHERIT_FALLBACK : (props.fallbacks[0] ?? "")}
            disabled={props.disabled}
            title={props.title}
            onOpen={props.onOpen}
            onChange={(value) =>
              props.inherit && value === INHERIT_FALLBACK
                ? props.inherit.reset()
                : props.onChange(value || null)
            }
          />
          <Show when={editing()}>{props.chainEditor?.()}</Show>
        </div>
      }
    />
  );
}

type Picker = Omit<ModelPickerParams, "label">;
export function ModelSettingsRows(props: {
  scope: "agent" | "model-providers";
  primary: Picker;
  primaryDescription?: JSX.Element;
  thinking: Behavior<string>;
  thinkingLevels: ModelCatalogEntry["thinkingLevels"];
  speed: Behavior<FastMode>;
  model: ModelCatalogEntry | undefined;
  hasAdvanced: boolean;
  fallback: FallbackSetting;
  subagent: Picker;
  utility: Picker;
  utilityDescription?: JSX.Element;
  utilityFallback: FallbackSetting;
  decision: DecisionModelPickerParams;
  message?: JSX.Element;
}) {
  const agent = () => props.scope === "agent";
  const thinkingOptions = createMemo(() => {
    const options: { value: string; label: string; disabled?: boolean }[] = dedupeByKey(
      props.thinkingLevels ?? [],
      (level) => level.id,
    ).map((level) => ({ value: level.id, label: thinkingLevelLabel(t, level.id, level.label) }));
    const saved = props.thinking.value;
    if (saved && !options.some((option) => option.value === saved)) {
      options.push({ value: saved, label: thinkingLevelLabel(t, saved), disabled: true });
    }
    return options;
  });
  const speed = createMemo(() =>
    props.speed.value === undefined ? undefined : formatFastModeValue(props.speed.value),
  );
  const speeds = createMemo(() => speedOptions(props.model, speed()));
  // Start expanded for authored advanced choices. Clearing the last one keeps its row in place.
  const [moreOpen, setMoreOpen] = createSignal<boolean>(
    (open) => open === true || props.hasAdvanced,
  );
  return (
    <div class="model-providers__defaults">
      <SettingsRow
        title={t("modelProviders.defaults.primary")}
        description={props.primaryDescription}
        control={
          <ModelPicker windowed {...props.primary} label={t("modelProviders.defaults.primary")} />
        }
      />
      <BehaviorSetting
        {...props.thinking}
        field="thinking"
        prefix={props.scope}
        options={thinkingOptions()}
        defaultHelp={t(
          agent()
            ? "agents.overview.inheritBehaviorHelp"
            : "modelProviders.defaults.thinkingDefaultHelp",
        )}
      />
      <BehaviorSetting
        {...props.speed}
        field="fastMode"
        prefix={props.scope}
        value={speed()}
        options={speeds()}
        defaultHelp={t(
          agent()
            ? "agents.overview.inheritBehaviorHelp"
            : "modelProviders.defaults.fastModeDefaultHelp",
        )}
        onChange={(value) => {
          if (value !== speed()) {
            props.speed.onChange(
              value === "auto" || value === "ultrafast" ? value : value === "on",
            );
          }
        }}
      />
      <button
        type="button"
        class="settings-row settings-row--nav settings-details-toggle"
        aria-expanded={moreOpen() ? "true" : "false"}
        data-models-more-settings
        onClick={() => setMoreOpen(!moreOpen())}
      >
        <div class="settings-row__text">
          <span class="settings-row__title">{t("modelProviders.defaults.moreSettings")}</span>
        </div>
        <div class="settings-row__control">
          <span class="settings-row__chevron">
            <Icon name="chevronRight" />
          </span>
        </div>
      </button>

      <Show when={moreOpen()}>
        <FallbackModel {...props.fallback} label={t("modelProviders.defaults.fallback")} />
        <SettingsRow
          title={
            <HelpTitle
              title={t("modelProviders.defaults.subagent")}
              label={t("modelProviders.defaults.subagentHelpLabel")}
              triggerId={`${props.scope}-subagent-help`}
              paragraphs={[
                t(
                  agent()
                    ? "agents.overview.subagentModelHelp"
                    : "modelProviders.defaults.subagentHelpPurpose",
                ),
                t(
                  agent()
                    ? "agents.overview.subagentWithoutDefault"
                    : "modelProviders.defaults.subagentHelpInherit",
                ),
              ]}
            />
          }
          control={
            <ModelPicker
              windowed
              {...props.subagent}
              label={t("modelProviders.defaults.subagent")}
            />
          }
        />
        <SettingsRow
          title={
            <HelpTitle
              title={t("modelProviders.defaults.utility")}
              label={t("modelProviders.defaults.utilityHelpLabel")}
              triggerId={`${props.scope}-utility-help`}
              paragraphs={[
                t(
                  agent()
                    ? "agents.overview.utilityModelHelp"
                    : "modelProviders.defaults.utilityHelpPurpose",
                ),
                t("modelProviders.defaults.utilityHelpAutomatic"),
              ]}
            />
          }
          description={props.utilityDescription}
          control={
            <ModelPicker windowed {...props.utility} label={t("modelProviders.defaults.utility")} />
          }
        />
        <FallbackModel
          {...props.utilityFallback}
          label={t("modelProviders.defaults.utilityFallback")}
        />
        <SettingsRow
          title={
            <HelpTitle
              title={t("chat.modelControls.decisionLabel")}
              label={t("modelProviders.defaults.decisionHelpLabel")}
              triggerId={`${props.scope}-decision-help`}
              paragraphs={[
                t(
                  agent()
                    ? "chat.modelControls.decisionAgentHelp"
                    : "chat.modelControls.decisionHelp",
                ),
              ]}
            />
          }
          control={<DecisionModelPicker {...props.decision} />}
        />
      </Show>
      {props.message}
    </div>
  );
}
