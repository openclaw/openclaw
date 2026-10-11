import { html, nothing, type TemplateResult } from "lit";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { BASE_THINKING_LEVELS } from "../../../../src/auto-reply/thinking.shared.js";
import { dedupeByKey } from "../../../../src/shared/dedupe-by-key.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode, ModelAuthStatusProvider, ModelAuthStatusResult } from "../../api/types.ts";
import {
  renderDecisionModelPicker,
  type DecisionModelEntry,
} from "../../components/decision-model-picker.ts";
import { icons } from "../../components/icons.ts";
import { renderModelPicker, type ModelPickerOption } from "../../components/model-picker.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatThinkingOverrideLabel } from "../../lib/chat/thinking.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../lib/model-auth.ts";
import { describeModelProviderAuth } from "../../lib/model-provider-auth-label.ts";
import { formatCompletionRoute, type CompletionRoute } from "../../lib/model-runtime-label.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { modelCatalogRef, type DefaultModelSelection, type ModelPickerEntry } from "./data.ts";
import { renderMutationMessage } from "./view-status.ts";

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

function renderHelpTitle(params: {
  title: string;
  label: string;
  triggerId: string;
  paragraphs: string[];
}) {
  return html`
    <span class="model-providers__label-with-help">
      <span>${params.title}</span>
      <span class="settings-section__docs">
        <openclaw-tooltip open-on-click>
          <button
            id=${params.triggerId}
            type="button"
            class="settings-section__help-button model-providers__help-button"
            aria-label=${params.label}
            @keydown=${(event: KeyboardEvent) => {
              if (event.key === "Escape") {
                event.stopPropagation();
              }
            }}
          >
            ${icons.info}
          </button>
          <div slot="content" class="settings-section__help-panel">
            ${params.paragraphs.map((text) => html`<p>${text}</p>`)}
          </div>
        </openclaw-tooltip>
      </span>
    </span>
  `;
}

function renderBehaviorSetting<Value extends string>(
  field: "thinking" | "fastMode",
  props: DefaultModelsViewProps,
  control: {
    value: Value | "";
    options: { value: Value; label: string }[];
    overridden: boolean;
    onChange: (value: Value) => void;
    onReset: () => void;
  },
) {
  return renderSettingsRow({
    title: renderHelpTitle({
      title: t(`quickSettings.model.${field}`),
      label: t(`modelProviders.defaults.${field}HelpLabel`),
      triggerId: field === "thinking" ? THINKING_HELP_ID : FAST_MODE_HELP_ID,
      paragraphs: [
        t(`modelProviders.defaults.${field}Help`),
        t(`modelProviders.defaults.${field}DefaultHelp`),
      ],
    }),
    control: html`${renderSettingsSegmented<Value | "">({
      value: control.value,
      ariaLabel: t(`quickSettings.model.${field}`),
      options: [{ value: "", label: t("quickSettings.model.default") }, ...control.options],
      disabled: Boolean(props.busy.defaults) || !props.canMutate,
      onChange: (value) => (value === "" ? control.onReset() : control.onChange(value)),
      onReselect: (value) => {
        if (value === "" && control.overridden) {
          control.onReset();
        }
      },
    })}`,
  });
}

function fastModeOptionValue(value: ReturnType<typeof formatFastModeValue>): FastMode {
  return value === "auto" || value === "ultrafast" ? value : value === "on";
}

// Discovery progress does not change the saved selection or disable known models.
function renderCatalogProgress(props: DefaultModelsViewProps): TemplateResult {
  return html`
    ${
      props.catalogDiscovering
        ? html`
            <div class="model-providers__catalog-progress" role="status" aria-live="polite">
              <span class="btn__spinner" aria-hidden="true"></span>
              <span>${t("modelProviders.defaults.discoveringMore")}</span>
            </div>
          `
        : nothing
    }
    ${
      props.catalogDiscoveryError
        ? html`
            <div class="model-providers__catalog-progress" role="alert" aria-live="polite">
              <span>${t("modelProviders.defaults.discoverFailed")}</span>
              <button class="btn btn--sm" type="button" @click=${props.onCatalogRetry}>
                ${t("modelProviders.defaults.retryDiscover")}
              </button>
            </div>
          `
        : nothing
    }
  `;
}

export function renderDefaultModels(props: DefaultModelsViewProps) {
  const modelControlsDisabled = !props.canMutate || props.models.length === 0;
  const saving = Boolean(props.busy.defaults);
  const title = props.mutationBlockedReason ?? "";
  const thinkingLevels =
    props.thinkingLevel && !THINKING_LEVEL_SET.has(props.thinkingLevel)
      ? [...THINKING_LEVELS, props.thinkingLevel]
      : THINKING_LEVELS;
  const fastMode = props.fastMode === undefined ? "" : formatFastModeValue(props.fastMode);
  const fallback = props.selection.fallbacks[0] ?? "";
  const authProviders = new Map(
    listEffectiveModelAuthProviders(props.authStatus?.providers ?? []).map((provider) => [
      provider.provider,
      provider,
    ]),
  );
  const options = dedupeByKey(props.models, modelCatalogRef).map((model) =>
    modelOption(model, authProviders),
  );
  const automaticRef = props.automaticUtilityModel;
  const utilityValue = props.selection.utilityModel ?? AUTOMATIC_UTILITY_VALUE;
  const utilityRoute = formatCompletionRoute(props.utilityRuntime);
  // The route describes the model in effect, so it joins that option's account detail.
  const withUtilityRoute = (value: string, detail: string | undefined) =>
    value === utilityValue && utilityRoute
      ? [detail, utilityRoute.label].filter(Boolean).join(" · ")
      : detail;
  const automaticBaseRef = automaticRef ? splitTrailingAuthProfile(automaticRef).model : "";
  const automaticEntry = props.models.find((model) => modelCatalogRef(model) === automaticBaseRef);
  const automaticModel = automaticRef
    ? modelOption(
        {
          ...(automaticEntry ?? {
            id: automaticBaseRef,
            name: automaticBaseRef,
            provider: automaticBaseRef.split("/", 1)[0] ?? "",
          }),
          selectionRef: automaticRef,
        },
        authProviders,
      )
    : undefined;

  const body = html`
    <div class="model-providers__defaults">
      ${
        !props.loading && props.models.length === 0
          ? html`<div class="callout warning">${t("modelProviders.defaults.noModels")}</div>`
          : nothing
      }
      ${renderSettingsRow({
        title: t("modelProviders.defaults.primary"),
        control: renderModelPicker({
          label: t("modelProviders.defaults.primary"),
          value: props.selection.primary,
          options: [
            {
              value: "",
              label: t("modelProviders.defaults.selectModel"),
              disabled: !props.canMutate || Boolean(props.selection.primary),
            },
            ...(props.canMutate
              ? options
              : options.map((option) => ({ ...option, disabled: true }))),
          ],
          disabled: props.models.length === 0 || saving,
          title,
          showSelectedDetail: true,
          onChange: props.onPrimaryChange,
        }),
      })}
      ${renderSettingsRow({
        title: renderHelpTitle({
          title: t("modelProviders.defaults.utility"),
          label: t("modelProviders.defaults.utilityHelpLabel"),
          triggerId: UTILITY_MODEL_HELP_ID,
          paragraphs: [
            t("modelProviders.defaults.utilityHelpPurpose"),
            t("modelProviders.defaults.utilityHelpAutomatic"),
          ],
        }),
        control: renderModelPicker({
          id: UTILITY_MODEL_PICKER_ID,
          label: t("modelProviders.defaults.utility"),
          value: utilityValue,
          options: [
            {
              value: AUTOMATIC_UTILITY_VALUE,
              label: props.automaticUtilityModel
                ? `${t("quickSettings.model.fastModes.auto")} · ${automaticModel?.label ?? props.automaticUtilityModel}`
                : t("quickSettings.model.fastModes.auto"),
              provider: automaticModel?.provider,
              detail:
                automaticRef === null
                  ? t("modelProviders.defaults.automaticUnavailable")
                  : withUtilityRoute(AUTOMATIC_UTILITY_VALUE, automaticModel?.detail),
            },
            { value: "", label: t("modelProviders.defaults.disabled") },
            ...options.map((option) => {
              const detail = withUtilityRoute(option.value, option.detail);
              return detail === option.detail ? option : { ...option, detail };
            }),
          ],
          disabled: modelControlsDisabled || saving,
          // A blocked mutation explains itself first; otherwise the tooltip explains the route.
          title: title || utilityRoute?.detail || "",
          showSelectedDetail: true,
          onChange: (value) =>
            props.onUtilityChange(value === AUTOMATIC_UTILITY_VALUE ? null : value),
        }),
      })}
      ${renderSettingsRow({
        title: t("chat.modelControls.decisionLabel"),
        description: t("chat.modelControls.decisionHelp"),
        control: renderDecisionModelPicker({
          id: "model-providers-decision-model",
          models: props.decisionModels,
          value: props.selection.decisionModel,
          disabled: !props.canMutate || saving,
          title,
          onChange: props.onDecisionChange,
        }),
      })}
      ${renderSettingsRow({
        title: t("modelProviders.defaults.fallback"),
        control: renderModelPicker({
          label: t("modelProviders.defaults.fallback"),
          value: fallback,
          options: [
            { value: "", label: t("modelProviders.defaults.noFallback") },
            ...options.filter((option) => option.value !== props.selection.primary),
          ],
          disabled: modelControlsDisabled || saving || !props.selection.primary,
          title,
          showSelectedDetail: true,
          onChange: (value) => props.onFallbackChange(value || null),
        }),
      })}
      ${renderBehaviorSetting("thinking", props, {
        value: props.thinkingLevel ?? "",
        options: thinkingLevels.map((level) => ({
          value: level,
          label: THINKING_LEVEL_SET.has(level)
            ? t(`quickSettings.model.thinkingLevels.${level}`)
            : formatThinkingOverrideLabel(level),
        })),
        overridden: props.thinkingOverridden,
        onChange: props.onThinkingChange,
        onReset: props.onThinkingReset,
      })}
      ${renderBehaviorSetting<ReturnType<typeof formatFastModeValue>>("fastMode", props, {
        value: fastMode,
        options: [
          { value: "auto", label: t("quickSettings.model.fastModes.auto") },
          { value: "on", label: t("quickSettings.model.fastModes.on") },
          { value: "off", label: t("quickSettings.model.fastModes.off") },
        ],
        overridden: props.fastModeOverridden,
        onChange: (value) => {
          if (value !== fastMode) {
            props.onFastModeChange(fastModeOptionValue(value));
          }
        },
        onReset: props.onFastModeReset,
      })}
      ${renderCatalogProgress(props)}
      ${props.canMutate ? renderMutationMessage(props.message) : nothing}
    </div>
  `;
  return renderSettingsSection(
    {
      title: t("modelProviders.defaults.title"),
      description: t("modelProviders.defaults.subtitle"),
    },
    body,
  );
}
