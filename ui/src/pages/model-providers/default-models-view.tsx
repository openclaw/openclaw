import type { JSX } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { BASE_THINKING_LEVELS } from "../../../../src/auto-reply/thinking.shared.js";
import { dedupeByKey } from "../../../../src/shared/dedupe-by-key.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode, ModelAuthStatusProvider, ModelAuthStatusResult } from "../../api/types.ts";
import {
  DecisionModelPicker,
  type DecisionModelEntry,
} from "../../components/solid/decision-model-picker.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { ModelPicker, type ModelPickerOption } from "../../components/solid/model-picker.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { formatThinkingOverrideLabel } from "../../lib/chat/thinking.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";
import { describeModelProviderAuth } from "../../lib/model-provider-auth-label.ts";
import { formatCompletionRoute, type CompletionRoute } from "../../lib/model-runtime-label.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { modelCatalogRef, type DefaultModelSelection, type ModelPickerEntry } from "./data.ts";
import { renderMutationMessage } from "./view-status.tsx";

export type DefaultModelsViewProps = {
  models: ModelPickerEntry[];
  decisionModels: DecisionModelEntry[];
  selection: DefaultModelSelection;
  authStatus?: ModelAuthStatusResult | null;
  automaticUtilityModel?: string | null;
  /** Route the utility model in effect (automatic or explicit) runs on. */
  utilityRuntime?: CompletionRoute;
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
  loading?: boolean;
  catalogDiscovering?: boolean;
  /** Retryable discovery error from the current catalog publication or explicit Retry. */
  catalogDiscoveryError?: string | null;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  busy: Record<string, boolean>;
  message?: ModelProviderRowMessage;
  onPrimaryChange: (model: string) => void;
  onFallbackChange: (model: string | null) => void;
  onUtilityChange: (model: string | null) => void;
  onDecisionChange: (model: string | null) => void;
  onThinkingChange: (level: string) => void;
  onThinkingReset: () => void;
  onFastModeChange: (mode: FastMode) => void;
  onFastModeReset: () => void;
  onCatalogRetry: () => void;
};

const AUTOMATIC_UTILITY_VALUE = "__openclaw_automatic_utility__";
const UTILITY_MODEL_PICKER_ID = "model-providers-utility-model";
const UTILITY_MODEL_HELP_ID = "model-providers-utility-help";
const THINKING_HELP_ID = "model-providers-thinking-help";
const FAST_MODE_HELP_ID = "model-providers-fast-mode-help";

// The global default intentionally omits "minimal"; the full list stays
// available on session-level pickers.
const THINKING_LEVELS = BASE_THINKING_LEVELS.filter((level) => level !== "minimal");
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

function modelOption(
  model: ModelPickerEntry,
  authProviders: ReadonlyMap<string, ModelAuthStatusProvider>,
): ModelPickerOption {
  const ref = modelCatalogRef(model);
  const provider = authProviders.get(canonicalModelAuthProviderId(model.provider));
  const auth = provider
    ? describeModelProviderAuth(provider, {
        authProfileId: splitTrailingAuthProfile(ref).profile,
        projection: "available-credentials",
      })
    : undefined;
  return {
    value: ref,
    label: model.name || ref,
    ...(auth ? { detail: [auth.label, auth.detail].filter(Boolean).join(" · ") } : {}),
    ...(model.available === false ? { disabled: true } : {}),
    ...(model.provider ? { provider: model.provider } : {}),
  };
}

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
            <Icon name="info" />
          </button>
          <div slot="content" class="settings-section__help-panel">
            <For each={params.paragraphs}>{(text) => <p>{text}</p>}</For>
          </div>
        </openclaw-tooltip>
      </span>
    </span>
  );
}

function BehaviorSetting<Value extends string>(props: {
  field: "thinking" | "fastMode";
  view: DefaultModelsViewProps;
  value: Value | "";
  options: { value: Value; label: string }[];
  overridden: boolean;
  onChange: (value: Value) => void;
  onReset: () => void;
}) {
  const control = (
    <SettingsSegmented<Value | "">
      value={props.value}
      ariaLabel={t(`quickSettings.model.${props.field}`)}
      options={[{ value: "" as const, label: t("quickSettings.model.default") }, ...props.options]}
      disabled={Boolean(props.view.busy.defaults) || !props.view.canMutate}
      onChange={(value) => (value === "" ? props.onReset() : props.onChange(value))}
      onReselect={(value) => {
        if (value === "" && props.overridden) {
          props.onReset();
        }
      }}
    />
  );
  return (
    <SettingsRow
      title={
        <HelpTitle
          title={t(`quickSettings.model.${props.field}`)}
          label={t(`modelProviders.defaults.${props.field}HelpLabel`)}
          triggerId={props.field === "thinking" ? THINKING_HELP_ID : FAST_MODE_HELP_ID}
          paragraphs={[
            t(`modelProviders.defaults.${props.field}Help`),
            t(`modelProviders.defaults.${props.field}DefaultHelp`),
          ]}
        />
      }
      control={control}
    />
  );
}

function fastModeOptionValue(value: ReturnType<typeof formatFastModeValue>): FastMode {
  return value === "auto" || value === "ultrafast" ? value : value === "on";
}

// Discovery progress does not change the saved selection or disable known models.
function CatalogProgress(props: DefaultModelsViewProps): JSX.Element {
  return (
    <>
      {props.catalogDiscovering ? (
        <div class="model-providers__catalog-progress" role="status" aria-live="polite">
          <span class="btn__spinner" aria-hidden="true" />
          <span>{t("modelProviders.defaults.discoveringMore")}</span>
        </div>
      ) : undefined}
      {props.catalogDiscoveryError ? (
        <div class="model-providers__catalog-progress" role="alert" aria-live="polite">
          <span>{t("modelProviders.defaults.discoverFailed")}</span>
          <button class="btn btn--sm" type="button" onClick={() => props.onCatalogRetry()}>
            {t("modelProviders.defaults.retryDiscover")}
          </button>
        </div>
      ) : undefined}
    </>
  );
}

export function DefaultModels(props: DefaultModelsViewProps) {
  const modelControlsDisabled = () => !props.canMutate || props.models.length === 0;
  const saving = () => Boolean(props.busy.defaults);
  const title = () => props.mutationBlockedReason ?? "";
  const thinkingLevels = () =>
    props.thinkingLevel && !THINKING_LEVEL_SET.has(props.thinkingLevel)
      ? [...THINKING_LEVELS, props.thinkingLevel]
      : THINKING_LEVELS;
  const fastMode = () => (props.fastMode === undefined ? "" : formatFastModeValue(props.fastMode));
  const fallback = () => props.selection.fallbacks[0] ?? "";
  const authProviders = createMemo(
    () =>
      new Map(
        listEffectiveModelAuthProviders(props.authStatus?.providers ?? []).map((provider) => [
          provider.provider,
          provider,
        ]),
      ),
  );
  const options = createMemo(() =>
    dedupeByKey(props.models, modelCatalogRef).map((model) => modelOption(model, authProviders())),
  );
  const utilityValue = () => props.selection.utilityModel ?? AUTOMATIC_UTILITY_VALUE;
  const utilityRoute = () => formatCompletionRoute(props.utilityRuntime);
  const utilityOptions = createMemo(() => {
    const ref = props.automaticUtilityModel;
    const base = ref ? splitTrailingAuthProfile(ref).model : "";
    const entry = props.models.find((model) => modelCatalogRef(model) === base);
    const automatic = ref
      ? modelOption(
          {
            ...(entry ?? { id: base, name: base, provider: base.split("/", 1)[0] ?? "" }),
            selectionRef: ref,
          },
          authProviders(),
        )
      : undefined;
    // The effective model's route belongs beside its account detail.
    const withRoute = (value: string, detail: string | undefined) =>
      value === utilityValue() && utilityRoute()
        ? [detail, utilityRoute()?.label].filter(Boolean).join(" · ")
        : detail;
    return [
      {
        value: AUTOMATIC_UTILITY_VALUE,
        label: ref
          ? `${t("quickSettings.model.fastModes.auto")} · ${automatic?.label ?? ref}`
          : t("quickSettings.model.fastModes.auto"),
        provider: automatic?.provider,
        detail:
          ref === null
            ? t("modelProviders.defaults.automaticUnavailable")
            : withRoute(AUTOMATIC_UTILITY_VALUE, automatic?.detail),
      },
      { value: "", label: t("modelProviders.defaults.disabled") },
      ...options().map((option) => {
        const detail = withRoute(option.value, option.detail);
        return detail === option.detail ? option : Object.assign({}, option, { detail });
      }),
    ];
  });

  return (
    <SettingsSection
      title={t("modelProviders.defaults.title")}
      description={t("modelProviders.defaults.subtitle")}
    >
      <div class="model-providers__defaults">
        {!props.loading && props.models.length === 0 ? (
          <div class="callout warning">{t("modelProviders.defaults.noModels")}</div>
        ) : undefined}
        <SettingsRow
          title={t("modelProviders.defaults.primary")}
          control={
            <ModelPicker
              label={t("modelProviders.defaults.primary")}
              value={props.selection.primary}
              options={[
                {
                  value: "",
                  label: t("modelProviders.defaults.selectModel"),
                  disabled: !props.canMutate || Boolean(props.selection.primary),
                },
                ...(props.canMutate
                  ? options()
                  : options().map((option) => Object.assign({}, option, { disabled: true }))),
              ]}
              disabled={props.models.length === 0 || saving()}
              title={title()}
              showSelectedDetail={true}
              onChange={props.onPrimaryChange}
            />
          }
        />
        <SettingsRow
          title={
            <HelpTitle
              title={t("modelProviders.defaults.utility")}
              label={t("modelProviders.defaults.utilityHelpLabel")}
              triggerId={UTILITY_MODEL_HELP_ID}
              paragraphs={[
                t("modelProviders.defaults.utilityHelpPurpose"),
                t("modelProviders.defaults.utilityHelpAutomatic"),
              ]}
            />
          }
          control={
            <ModelPicker
              id={UTILITY_MODEL_PICKER_ID}
              label={t("modelProviders.defaults.utility")}
              value={utilityValue()}
              options={utilityOptions()}
              disabled={modelControlsDisabled() || saving()}
              title={title() || utilityRoute()?.detail || ""}
              showSelectedDetail={true}
              onChange={(value) =>
                props.onUtilityChange(value === AUTOMATIC_UTILITY_VALUE ? null : value)
              }
            />
          }
        />
        <SettingsRow
          title={t("chat.modelControls.decisionLabel")}
          description={t("chat.modelControls.decisionHelp")}
          control={
            <DecisionModelPicker
              id={"model-providers-decision-model"}
              models={props.decisionModels}
              value={props.selection.decisionModel}
              disabled={!props.canMutate || saving()}
              title={title()}
              onChange={props.onDecisionChange}
            />
          }
        />
        <SettingsRow
          title={t("modelProviders.defaults.fallback")}
          control={
            <ModelPicker
              label={t("modelProviders.defaults.fallback")}
              value={fallback()}
              options={[
                { value: "", label: t("modelProviders.defaults.noFallback") },
                ...options().filter((option) => option.value !== props.selection.primary),
              ]}
              disabled={modelControlsDisabled() || saving() || !props.selection.primary}
              title={title()}
              showSelectedDetail={true}
              onChange={(value) => props.onFallbackChange(value || null)}
            />
          }
        />
        <BehaviorSetting
          field={"thinking"}
          view={props}
          value={props.thinkingLevel ?? ""}
          options={thinkingLevels().map((level) => ({
            value: level,
            label: THINKING_LEVEL_SET.has(level)
              ? t(`quickSettings.model.thinkingLevels.${level}`)
              : formatThinkingOverrideLabel(level),
          }))}
          overridden={props.thinkingOverridden}
          onChange={props.onThinkingChange}
          onReset={props.onThinkingReset}
        />
        <BehaviorSetting<ReturnType<typeof formatFastModeValue>>
          field={"fastMode"}
          view={props}
          value={fastMode()}
          options={[
            { value: "auto", label: t("quickSettings.model.fastModes.auto") },
            { value: "on", label: t("quickSettings.model.fastModes.on") },
            { value: "off", label: t("quickSettings.model.fastModes.off") },
          ]}
          overridden={props.fastModeOverridden}
          onChange={(value) => {
            if (value !== fastMode()) {
              props.onFastModeChange(fastModeOptionValue(value));
            }
          }}
          onReset={props.onFastModeReset}
        />
        <CatalogProgress {...props} />
        {props.canMutate ? renderMutationMessage(props.message) : undefined}
      </div>
    </SettingsSection>
  );
}
