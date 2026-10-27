import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, isPending, latest, Loading } from "solid-js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { dedupeByKey } from "../../../../src/shared/dedupe-by-key.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode, ModelAuthStatusProvider, ModelAuthStatusResult } from "../../api/types.ts";
import {
  DecisionModelPicker,
  type DecisionModelEntry,
} from "../../components/solid/decision-model-picker.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InteractionModelPicker } from "../../components/solid/interaction-model-picker.tsx";
import { ModelPicker, type ModelPickerOption } from "../../components/solid/model-picker.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { formatThinkingOverrideLabel } from "../../lib/chat/thinking.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";
import { describeModelProviderAuth } from "../../lib/model-provider-auth-label.ts";
import { formatCompletionRoute, type CompletionRoute } from "../../lib/model-runtime-label.ts";
import { modelSettingFallbacks, modelSettingPrimary } from "../../lib/model-setting.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ModelDefaultsSaveField, ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCatalogReceipt } from "./core-load.ts";
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
  catalogReceipt?: ModelProviderCatalogReceipt | null;
  /** Retryable discovery error from the current catalog publication or explicit Retry. */
  catalogDiscoveryError?: string | null;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  busy: Record<string, boolean>;
  defaultsSaving?: boolean;
  defaultsSavingField?: ModelDefaultsSaveField | null;
  message?: ModelProviderRowMessage;
  onPrimaryChange: (model: string) => void;
  onFallbackChange: (model: string | null) => void;
  onUtilityChange: (model: string | null) => void;
  onUtilityFallbackChange: (model: string | null) => void;
  onDecisionChange: (model: string | null) => void;
  onInteractionModelChange: (kind: "computer" | "browser", model: string | null) => void;
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
const TRANSLATED_THINKING_LEVELS = new Set(["off", "low", "medium", "high"]);

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
    ...(auth ? { description: [auth.label, auth.detail].filter(Boolean).join(" · ") } : {}),
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
  options: { value: Value; label: string; disabled?: boolean }[];
  overridden: boolean;
  onChange: (value: Value) => void;
  onReset: () => void;
}) {
  const saving = () =>
    props.view.defaultsSavingField === props.field &&
    (props.view.defaultsSaving || Boolean(props.view.busy.defaults));
  const control = (
    <SettingsSegmented<Value | "">
      value={props.value}
      ariaLabel={t(`quickSettings.model.${props.field}`)}
      options={[{ value: "" as const, label: t("quickSettings.model.default") }, ...props.options]}
      disabled={
        !props.view.canMutate ||
        ((props.view.defaultsSaving || Boolean(props.view.busy.defaults)) && !saving())
      }
      saving={saving()}
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

function thinkingLevelLabel(value: string, label?: string): string {
  return TRANSLATED_THINKING_LEVELS.has(value)
    ? t(`quickSettings.model.thinkingLevels.${value}`)
    : formatThinkingOverrideLabel(value, label);
}

function fastModeOptionValue(value: ReturnType<typeof formatFastModeValue>): FastMode {
  return value === "auto" || value === "ultrafast" ? value : value === "on";
}

// Discovery progress does not change the saved selection or disable known models.
function CatalogFeedback(props: {
  discovering: boolean;
  error?: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <>
      {props.discovering ? (
        <div class="model-providers__catalog-progress" role="status" aria-live="polite">
          <span class="btn__spinner" aria-hidden="true" />
          <span>{t("modelProviders.defaults.discoveringMore")}</span>
        </div>
      ) : undefined}
      {props.error ? (
        <div class="model-providers__catalog-progress" role="alert" aria-live="polite">
          <span>{props.error}</span>
          <button class="btn btn--sm" type="button" onClick={() => props.onRetry()}>
            {t("modelProviders.defaults.retryDiscover")}
          </button>
        </div>
      ) : undefined}
    </>
  );
}

function CatalogProgress(props: DefaultModelsViewProps): JSX.Element {
  const receipt = createMemo(() => props.catalogReceipt);
  const error = createMemo(() => props.catalogDiscoveryError);
  const read = createMemo(() => {
    const currentError = error();
    return (receipt()?.promise ?? Promise.resolve(null)).then((completionError) => {
      const failure = completionError ?? currentError;
      if (failure) {
        throw new Error(failure);
      }
      return null;
    });
  });
  return (
    <div class="model-providers__catalog-feedback">
      <Errored
        fallback={(failure, reset) => {
          const retry = () => {
            props.onCatalogRetry();
            reset();
          };
          return (
            <Loading fallback={<CatalogFeedback discovering onRetry={retry} />}>
              <CatalogFeedback
                discovering={isPending(read) || Boolean(props.catalogDiscovering)}
                error={isPending(read) ? undefined : formatUiError(failure())}
                onRetry={retry}
              />
            </Loading>
          );
        }}
      >
        <Loading
          fallback={
            <CatalogFeedback
              discovering={Boolean(receipt()) || Boolean(props.catalogDiscovering)}
              onRetry={() => props.onCatalogRetry()}
            />
          }
        >
          {latest(read)}
          <CatalogFeedback
            discovering={isPending(read) || Boolean(props.catalogDiscovering)}
            onRetry={() => props.onCatalogRetry()}
          />
        </Loading>
      </Errored>
    </div>
  );
}

function FallbackModel(props: {
  label: string;
  fallbacks: string[];
  primary: string | undefined;
  options: ModelPickerOption[];
  disabled: boolean;
  title: string;
  onChange: (model: string | null) => void;
}) {
  const primary = createMemo(() => props.primary);
  const modelOptions = createMemo(() => props.options);
  const count = createMemo(() => props.fallbacks.length);
  const options = createMemo(() => {
    const excluded = primary();
    return [
      {
        value: "",
        label:
          count() > 1
            ? t("modelProviders.defaults.clearFallbacks", { count: String(count()) })
            : t("modelProviders.defaults.noFallback"),
      },
      ...modelOptions().filter((option) => option.value !== excluded),
    ];
  });
  return (
    <SettingsRow
      title={props.label}
      description={
        props.fallbacks.length > 1
          ? t(
              props.fallbacks.length === 2
                ? "modelProviders.defaults.moreFallbackOne"
                : "modelProviders.defaults.moreFallbacks",
              { count: String(props.fallbacks.length - 1) },
            )
          : undefined
      }
      control={
        <ModelPicker
          windowed
          label={props.label}
          value={props.fallbacks[0] ?? ""}
          options={options()}
          disabled={props.disabled}
          title={props.title}
          onChange={(value) => props.onChange(value || null)}
        />
      }
    />
  );
}

export function DefaultModels(props: DefaultModelsViewProps) {
  const models = createMemo(() => props.models);
  const primary = createMemo(() => props.selection.primary);
  const canMutate = createMemo(() => props.canMutate);
  const thinkingLevel = createMemo(() => props.thinkingLevel);
  const modelControlsDisabled = () => !canMutate() || models().length === 0;
  const saving = () => props.defaultsSaving || Boolean(props.busy.defaults);
  const title = () => props.mutationBlockedReason ?? "";
  const primaryModel = createMemo(() => {
    const selected = primary();
    return models().find((model) => modelCatalogRef(model) === selected);
  });
  const thinkingOptions = createMemo(() => {
    const options: { value: string; label: string; disabled?: boolean }[] = dedupeByKey(
      primaryModel()?.thinkingLevels ?? [],
      (level) => level.id,
    ).map((level) => ({
      value: level.id,
      label: thinkingLevelLabel(level.id, level.label),
    }));
    // Catalog refreshes and model switches must not rewrite a saved global preference.
    const selected = thinkingLevel();
    if (selected && !options.some((option) => option.value === selected)) {
      options.push({
        value: selected,
        label: thinkingLevelLabel(selected),
        disabled: true,
      });
    }
    return options;
  });
  const fastMode = createMemo(() =>
    props.fastMode === undefined ? "" : formatFastModeValue(props.fastMode),
  );
  const fastModeOptions = createMemo(() => {
    const model = primaryModel();
    const priority =
      model?.supportsFastMode === true &&
      (model.serviceTiers === undefined || model.serviceTiers.includes("priority"));
    const ultrafast =
      model?.supportsFastMode === true &&
      model.available === true &&
      model.serviceTiers?.includes("ultrafast") === true;
    const options = [
      {
        value: "auto" as const,
        label: t("quickSettings.model.fastModes.auto"),
        supported: priority,
      },
      { value: "on" as const, label: t("quickSettings.model.fastModes.on"), supported: priority },
      {
        value: "ultrafast" as const,
        label: t("chat.modelControls.ultrafast"),
        supported: ultrafast,
      },
      { value: "off" as const, label: t("quickSettings.model.fastModes.off"), supported: true },
    ];
    return options
      .filter((option) => option.supported || option.value === fastMode())
      .map((option) => ({ value: option.value, label: option.label, disabled: !option.supported }));
  });
  const authStatusProviders = createMemo(() => props.authStatus?.providers);
  const authProviders = createMemo(
    () =>
      new Map(
        listEffectiveModelAuthProviders(authStatusProviders() ?? []).map((provider) => [
          provider.provider,
          provider,
        ]),
      ),
  );
  const options = createMemo(() => {
    const providers = authProviders();
    return dedupeByKey(models(), modelCatalogRef).map((model) => modelOption(model, providers));
  });
  const primaryOptions = createMemo(() => [
    {
      value: "",
      label: t("modelProviders.defaults.selectModel"),
      disabled: !canMutate() || Boolean(primary()),
    },
    ...(canMutate()
      ? options()
      : options().map((option) => Object.assign({}, option, { disabled: true }))),
  ]);
  const utilityValue = createMemo(
    () => modelSettingPrimary(props.selection.utilityModel) ?? AUTOMATIC_UTILITY_VALUE,
  );
  const utilityRuntime = createMemo(() => props.utilityRuntime);
  const utilityRoute = createMemo(() => formatCompletionRoute(utilityRuntime()));
  const automaticUtilityModel = createMemo(() => props.automaticUtilityModel);
  const utilityOptions = createMemo(() => {
    const ref = automaticUtilityModel();
    const base = ref ? splitTrailingAuthProfile(ref).model : "";
    const entry = models().find((model) => modelCatalogRef(model) === base);
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
    const selected = utilityValue();
    const route = utilityRoute();
    const choices: ModelPickerOption[] = [
      {
        value: AUTOMATIC_UTILITY_VALUE,
        label: ref
          ? `${t("quickSettings.model.fastModes.auto")} · ${automatic?.label ?? ref}`
          : t("quickSettings.model.fastModes.auto"),
        provider: automatic?.provider,
        description:
          ref === null
            ? t("modelProviders.defaults.automaticUnavailable")
            : selected === AUTOMATIC_UTILITY_VALUE && route
              ? [automatic?.description, route.label].filter(Boolean).join(" · ")
              : automatic?.description,
      },
      { value: "", label: t("modelProviders.defaults.disabled") },
    ];
    for (const option of options()) {
      const description =
        option.value === selected && route
          ? [option.description, route.label].filter(Boolean).join(" · ")
          : option.description;
      choices.push(
        description === option.description ? option : Object.assign({}, option, { description }),
      );
    }
    return choices;
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
              windowed
              label={t("modelProviders.defaults.primary")}
              value={primary()}
              options={primaryOptions()}
              disabled={props.models.length === 0 || saving()}
              title={title()}
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
              windowed
              id={UTILITY_MODEL_PICKER_ID}
              label={t("modelProviders.defaults.utility")}
              value={utilityValue()}
              options={utilityOptions()}
              disabled={modelControlsDisabled() || saving()}
              title={title() || utilityRoute()?.detail || ""}
              onChange={(value) =>
                props.onUtilityChange(value === AUTOMATIC_UTILITY_VALUE ? null : value)
              }
            />
          }
        />
        <FallbackModel
          label={t("modelProviders.defaults.utilityFallback")}
          fallbacks={modelSettingFallbacks(props.selection.utilityModel)}
          primary={modelSettingPrimary(props.selection.utilityModel)}
          options={options()}
          disabled={modelControlsDisabled() || saving() || utilityValue() === ""}
          title={title()}
          onChange={props.onUtilityFallbackChange}
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
        <For each={["computer", "browser"] as const}>
          {(kind) => (
            <SettingsRow
              title={t(
                kind === "computer"
                  ? "chat.modelControls.computerLabel"
                  : "chat.modelControls.browserLabel",
              )}
              description={t("chat.modelControls.interactionHelp")}
              control={
                <InteractionModelPicker
                  id={"model-providers-" + kind + "-model"}
                  kind={kind}
                  models={models()}
                  value={props.selection[kind === "computer" ? "computerModel" : "browserModel"]}
                  disabled={modelControlsDisabled() || saving()}
                  title={title()}
                  onChange={(value) => props.onInteractionModelChange(kind, value)}
                />
              }
            />
          )}
        </For>
        <FallbackModel
          label={t("modelProviders.defaults.fallback")}
          fallbacks={props.selection.fallbacks}
          primary={props.selection.primary}
          options={options()}
          disabled={modelControlsDisabled() || saving() || !props.selection.primary}
          title={title()}
          onChange={props.onFallbackChange}
        />
        <BehaviorSetting
          field={"thinking"}
          view={props}
          value={props.thinkingLevel ?? ""}
          options={thinkingOptions()}
          overridden={props.thinkingOverridden}
          onChange={props.onThinkingChange}
          onReset={props.onThinkingReset}
        />
        <BehaviorSetting<ReturnType<typeof formatFastModeValue>>
          field={"fastMode"}
          view={props}
          value={fastMode()}
          options={fastModeOptions()}
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
