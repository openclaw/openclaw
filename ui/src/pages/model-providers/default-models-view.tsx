import type { JSX } from "@solidjs/web";
import { createMemo, Errored, isPending, latest, Loading } from "solid-js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { dedupeByKey } from "../../../../src/shared/dedupe-by-key.js";
import type { FastMode, ModelAuthStatusProvider, ModelAuthStatusResult } from "../../api/types.ts";
import type { DecisionModelEntry } from "../../components/solid/decision-model-picker.tsx";
import type { ModelPickerOption } from "../../components/solid/model-picker.tsx";
import { ModelSettingsRows } from "../../components/solid/model-settings-rows.tsx";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";
import { describeModelProviderAuth } from "../../lib/model-provider-auth-label.ts";
import { resolveModelRuntimeEntry } from "../../lib/model-runtime-choice.ts";
import {
  formatModelRuntimeLabel,
  formatCompletionRoute,
  type CompletionRoute,
} from "../../lib/model-runtime-label.ts";
import { modelSettingFallbacks, modelSettingPrimary } from "../../lib/model-setting.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type {
  ModelDefaultsSaveField,
  ModelProviderRowMessage,
  ModelRuntimePick,
} from "./config-mutation.ts";
import type { ModelProviderCatalogReceipt } from "./core-load.ts";
import {
  modelCatalogRef,
  type AgentUtilityOverride,
  type DefaultModelSelection,
  type ModelPickerEntry,
} from "./data.ts";
import { UtilityOverrides } from "./utility-overrides.tsx";
import { renderMutationMessage } from "./view-status.tsx";

export type DefaultModelsViewProps = {
  models: ModelPickerEntry[];
  decisionModels: DecisionModelEntry[];
  selection: DefaultModelSelection;
  authStatus?: ModelAuthStatusResult | null;
  automaticUtilityModel?: string | null;
  /** Agents with their own utility model settings; the rest use this default. */
  utilityOverrides?: AgentUtilityOverride[];
  onOpenAgent: (agentId: string) => void;
  basePath: string;
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
  /** The last defaults write was acknowledged; later discovery runs in the background. */
  defaultsSaved?: boolean;
  message?: ModelProviderRowMessage;
  onPrimaryChange: (model: string, runtime?: ModelRuntimePick) => void;
  onFallbackChange: (model: string | null, runtime?: ModelRuntimePick) => void;
  onUtilityChange: (model: string | null) => void;
  onUtilityFallbackChange: (model: string | null) => void;
  onDecisionChange: (model: string | null) => void;
  onSubagentChange: (model: string | null) => void;
  onThinkingChange: (level: string) => void;
  onThinkingReset: () => void;
  onFastModeChange: (mode: FastMode) => void;
  onFastModeReset: () => void;
  onCatalogRetry: () => void;
  /** The selected agent's own model when it differs from the default, as a sentence. */
  agentModel?: string;
};

const AUTOMATIC_UTILITY_VALUE = "__openclaw_automatic_utility__";
const INHERIT_SUBAGENT_VALUE = "__openclaw_inherit_subagent__";
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

function CatalogFeedback(props: { error?: string; onRetry: () => void }): JSX.Element {
  return (
    <>
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
            <Loading>
              <CatalogFeedback
                error={isPending(read) ? undefined : formatUiError(failure())}
                onRetry={retry}
              />
            </Loading>
          );
        }}
      >
        <Loading>{latest(read)}</Loading>
      </Errored>
    </div>
  );
}

export function DefaultModels(props: DefaultModelsViewProps) {
  const models = createMemo(() => props.models);
  const primary = createMemo(() => props.selection.primary);
  const canMutate = createMemo(() => props.canMutate);
  const modelControlsDisabled = () => !canMutate() || models().length === 0;
  const saving = () => props.defaultsSaving || Boolean(props.busy.defaults);
  const title = () => props.mutationBlockedReason ?? "";
  const primaryModel = createMemo(() => {
    const selected = primary();
    const entry = models().find((model) => modelCatalogRef(model) === selected);
    return resolveModelRuntimeEntry(entry, props.selection.runtimes?.[selected]?.id);
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
  const distinctModels = createMemo(() => dedupeByKey(models(), modelCatalogRef));
  const options = createMemo(() => {
    const providers = authProviders();
    return distinctModels().map((model) => modelOption(model, providers));
  });
  const chatChoices = createMemo(() => {
    const choices = new Map<
      string,
      ModelPickerOption & { model: string; runtime?: ModelRuntimePick }
    >();
    const rows = options();
    for (const [index, entry] of distinctModels().entries()) {
      const row = rows[index]!;
      const model = row.value;
      const pin = props.selection.runtimes?.[model]?.id;
      const runtimes = entry.defaultModelRuntimes;
      const alternatives =
        runtimes?.alternatives.filter((choice) => choice.manualSelectionAllowed !== false) ?? [];
      const base = runtimes?.base.agentRuntime.id ?? entry.agentRuntime?.id;
      const baseDisabled =
        (runtimes ? runtimes.base.available === false : row.disabled === true) ||
        entry.manualSelectionAllowed === false;
      if (entry.selectionRef || !base || (!alternatives.length && (!pin || pin === base))) {
        const label =
          pin && !entry.selectionRef
            ? formatModelRuntimeLabel(entry.provider, pin)?.label
            : undefined;
        choices.set(model, {
          ...row,
          ...(label ? { label: `${row.label} · ${label}`, labelSuffix: ` · ${label}` } : {}),
          model,
          disabled: baseDisabled,
        });
        continue;
      }
      const selected = pin ?? base;
      const route = (id: string, disabled: boolean) => {
        const value = id === selected ? model : JSON.stringify([model, id]);
        const label = formatModelRuntimeLabel(entry.provider, id)?.label ?? id;
        choices.set(value, {
          ...row,
          value,
          model,
          label: `${row.label} · ${label}`,
          labelSuffix: ` · ${label}`,
          disabled,
          runtime: { id, base },
        });
      };
      route(base, baseDisabled);
      for (const choice of alternatives) {
        route(choice.agentRuntime.id, choice.available === false);
      }
      if (!choices.has(model)) {
        route(selected, true);
      }
    }
    return choices;
  });
  function selectChatChoice(value: string, change: DefaultModelsViewProps["onPrimaryChange"]) {
    const choice = chatChoices().get(value);
    if (!choice || choice.disabled) {
      return;
    }
    if (choice.runtime) {
      change(choice.model, choice.runtime);
    } else {
      change(choice.model);
    }
  }
  const chatOptions = createMemo(() => [...chatChoices().values()]);
  const primaryOptions = createMemo(() => [
    ...(primary()
      ? []
      : [{ value: "", label: t("modelProviders.defaults.selectModel"), disabled: true }]),
    ...(canMutate()
      ? chatOptions()
      : chatOptions().map((option) => Object.assign({}, option, { disabled: true }))),
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
  const subagentValue = createMemo(
    () => modelSettingPrimary(props.selection.subagentModel ?? null) || INHERIT_SUBAGENT_VALUE,
  );
  const subagentOptions = createMemo(() => [
    { value: INHERIT_SUBAGENT_VALUE, label: t("modelProviders.defaults.subagentInherit") },
    ...options(),
  ]);

  const behaviorState = (field: "thinking" | "fastMode") => ({
    disabled: !canMutate() || (saving() && props.defaultsSavingField !== field),
    saving: saving() && props.defaultsSavingField === field,
  });
  // The heading probes its action slot; keep one owner for the discovery receipt.
  const catalogProgress = <CatalogProgress {...props} />;
  return (
    <SettingsSection
      title={t("modelProviders.defaults.title")}
      description={t("modelProviders.defaults.subtitle")}
      actions={catalogProgress}
    >
      <ModelSettingsRows
        scope="model-providers"
        model={primaryModel()}
        thinkingLevels={primaryModel()?.thinkingLevels}
        primary={{
          value: primary(),
          options: primaryOptions(),
          disabled: props.models.length === 0 || saving(),
          title: title(),
          onChange: (value) => selectChatChoice(value, props.onPrimaryChange),
        }}
        primaryDescription={props.agentModel}
        thinking={{
          ...behaviorState("thinking"),
          value: props.thinkingLevel,
          overridden: props.thinkingOverridden,
          onChange: props.onThinkingChange,
          onReset: props.onThinkingReset,
        }}
        speed={{
          ...behaviorState("fastMode"),
          value: props.fastMode,
          overridden: props.fastModeOverridden,
          onChange: props.onFastModeChange,
          onReset: props.onFastModeReset,
        }}
        hasAdvanced={
          props.selection.fallbacks.length > 0 ||
          props.selection.utilityModel !== null ||
          Boolean(props.selection.decisionModel) ||
          subagentValue() !== INHERIT_SUBAGENT_VALUE
        }
        fallback={{
          fallbacks: props.selection.fallbacks,
          isExcluded: (model) => model === props.selection.primary,
          options: chatOptions(),
          disabled: modelControlsDisabled() || saving() || !props.selection.primary,
          title: title(),
          onChange: (value) =>
            value ? selectChatChoice(value, props.onFallbackChange) : props.onFallbackChange(null),
        }}
        subagent={{
          id: "model-providers-subagent-model",
          value: subagentValue(),
          options: subagentOptions(),
          disabled: modelControlsDisabled() || saving(),
          title: title(),
          onChange: (value) =>
            props.onSubagentChange(value === INHERIT_SUBAGENT_VALUE ? null : value),
        }}
        utility={{
          id: "model-providers-utility-model",
          value: utilityValue(),
          options: utilityOptions(),
          disabled: modelControlsDisabled() || saving(),
          title: title() || utilityRoute()?.detail || "",
          onChange: (value) =>
            props.onUtilityChange(value === AUTOMATIC_UTILITY_VALUE ? null : value),
        }}
        utilityDescription={
          props.utilityOverrides?.length ? (
            <UtilityOverrides
              overrides={props.utilityOverrides}
              basePath={props.basePath}
              onOpen={props.onOpenAgent}
            />
          ) : undefined
        }
        utilityFallback={{
          fallbacks: modelSettingFallbacks(props.selection.utilityModel),
          isExcluded: (model) => model === modelSettingPrimary(props.selection.utilityModel),
          options: options(),
          disabled: modelControlsDisabled() || saving() || utilityValue() === "",
          title: title(),
          onChange: props.onUtilityFallbackChange,
        }}
        decision={{
          id: "model-providers-decision-model",
          models: props.decisionModels,
          value: props.selection.decisionModel,
          disabled: !props.canMutate || saving(),
          title: title(),
          onChange: props.onDecisionChange,
        }}
        message={props.canMutate ? renderMutationMessage(props.message) : undefined}
      />
    </SettingsSection>
  );
}
