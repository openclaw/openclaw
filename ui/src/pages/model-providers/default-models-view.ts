import { html, nothing, type TemplateResult } from "lit";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { BASE_THINKING_LEVELS } from "../../../../src/auto-reply/thinking.shared.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode, ModelAuthStatusProvider, ModelAuthStatusResult } from "../../api/types.ts";
import {
  renderDecisionModelPicker,
  type DecisionModelEntry,
} from "../../components/decision-model-picker.ts";
import {
  decisionTaskEntries,
  type DecisionTaskEntry,
  renderDecisionTaskRows,
  resolveGlobalDecisionTaskSelection,
} from "../../components/decision-task-rows.ts";
import { renderModelPicker, type ModelPickerOption } from "../../components/model-picker.ts";
import {
  renderSettingsInfoTitle,
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
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { modelCatalogRef, type DefaultModelSelection, type ModelPickerEntry } from "./data.ts";
import {
  renderDecisionInventory,
  type DecisionInventoryViewProps,
} from "./decision-inventory-view.ts";

type DefaultModelsViewProps = {
  models: ModelPickerEntry[];
  decisionModels: DecisionModelEntry[];
  decisionTasks: DecisionTaskEntry[];
  decisionInventory: Omit<DecisionInventoryViewProps, "disabled">;
  selection: DefaultModelSelection;
  authStatus?: ModelAuthStatusResult | null;
  automaticUtilityModel?: string | null;
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
  loading?: boolean;
  /** True while the Gateway is discovering additional models. */
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
  onDecisionTaskChange: (taskId: string, model: string | null) => void;
  onThinkingChange: (level: string, element: HTMLElement) => void;
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

function modelOptions(
  models: ModelPickerEntry[],
  authProviders: ReadonlyMap<string, ModelAuthStatusProvider>,
): ModelPickerOption[] {
  const seen = new Set<string>();
  const options: ModelPickerOption[] = [];
  for (const model of models) {
    const ref = modelCatalogRef(model);
    if (seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    options.push(modelOption(model, authProviders));
  }
  return options.toSorted((a, b) => a.label.localeCompare(b.label));
}

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

function fastModeOptionValue(value: "auto" | "on" | "off"): FastMode {
  return value === "auto" ? "auto" : value === "on";
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
  const behaviorControlsDisabled = !props.canMutate;
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
  const options = modelOptions(props.models, authProviders);
  const automaticRef = props.automaticUtilityModel;
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

  return html`
    ${renderSettingsSection(
      {
        title: t("modelProviders.defaults.llmSection"),
        description: t("modelProviders.defaults.subtitle"),
        notice: html`
          ${!props.loading && props.models.length === 0 ? html`<div class="callout warning">${t("modelProviders.defaults.noModels")}</div>` : nothing}
          ${renderCatalogProgress(props)}
        `,
      },
      html`
        ${renderSettingsRow({
          title: t("modelProviders.defaults.primary"),
          control: renderModelPicker({
            label: t("modelProviders.defaults.primary"),
            value: props.selection.primary,
            options: [
              {
                value: "",
                label: t("modelProviders.defaults.selectModel"),
                disabled: Boolean(props.selection.primary),
              },
              ...options,
            ],
            disabled: modelControlsDisabled || saving,
            title,
            showSelectedDetail: true,
            onChange: props.onPrimaryChange,
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
        ${renderSettingsRow({
          title: renderSettingsInfoTitle({
            title: t("quickSettings.model.thinking"),
            label: t("modelProviders.defaults.thinkingHelpLabel"),
            triggerId: THINKING_HELP_ID,
            body: html`
              <p>${t("modelProviders.defaults.thinkingHelp")}</p>
              <p>${t("modelProviders.defaults.thinkingDefaultHelp")}</p>
            `,
          }),
          control: html`
            ${renderSettingsSegmented({
              value: props.thinkingLevel ?? "",
              ariaLabel: t("quickSettings.model.thinking"),
              options: [
                {
                  value: "",
                  label: t("quickSettings.model.default"),
                },
                ...thinkingLevels.map((level) => ({
                  value: level,
                  label: THINKING_LEVEL_SET.has(level)
                    ? t(`quickSettings.model.thinkingLevels.${level}`)
                    : formatThinkingOverrideLabel(level),
                })),
              ],
              disabled: saving || behaviorControlsDisabled,
              onChange: (value, element) =>
                value === "" ? props.onThinkingReset() : props.onThinkingChange(value, element),
              onReselect: (value) => {
                if (value === "" && props.thinkingOverridden) {
                  props.onThinkingReset();
                }
              },
            })}
          `,
        })}
        ${renderSettingsRow({
          title: renderSettingsInfoTitle({
            title: t("quickSettings.model.fastMode"),
            label: t("modelProviders.defaults.fastModeHelpLabel"),
            triggerId: FAST_MODE_HELP_ID,
            body: html`
              <p>${t("modelProviders.defaults.fastModeHelp")}</p>
              <p>${t("modelProviders.defaults.fastModeDefaultHelp")}</p>
            `,
          }),
          control: html`
            ${renderSettingsSegmented<"" | "auto" | "on" | "off">({
              value: fastMode,
              ariaLabel: t("quickSettings.model.fastMode"),
              options: [
                {
                  value: "",
                  label: t("quickSettings.model.default"),
                },
                { value: "auto", label: t("quickSettings.model.fastModes.auto") },
                { value: "on", label: t("quickSettings.model.fastModes.on") },
                { value: "off", label: t("quickSettings.model.fastModes.off") },
              ],
              disabled: saving || behaviorControlsDisabled,
              onChange: (value) => {
                if (value === "") {
                  props.onFastModeReset();
                } else if (value !== fastMode) {
                  props.onFastModeChange(fastModeOptionValue(value));
                }
              },
              onReselect: (value) => {
                if (value === "" && props.fastModeOverridden) {
                  props.onFastModeReset();
                }
              },
            })}
          `,
        })}
      `,
    )}
    ${renderSettingsSection(
      {
        title: renderSettingsInfoTitle({
          title: t("modelProviders.defaults.utilitySection"),
          label: t("modelProviders.defaults.utilityHelpLabel"),
          triggerId: UTILITY_MODEL_HELP_ID,
          body: html`<p>${t("modelProviders.defaults.utilityHelpPurpose")}</p>
            <p>${t("modelProviders.defaults.utilityHelpAutomatic")}</p>`,
        }),
      },
      html`
        ${renderSettingsRow({
          title: t("modelProviders.defaults.utility"),
          control: renderModelPicker({
            id: UTILITY_MODEL_PICKER_ID,
            label: t("modelProviders.defaults.utility"),
            value: props.selection.utilityModel ?? AUTOMATIC_UTILITY_VALUE,
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
                    : automaticModel?.detail,
              },
              { value: "", label: t("modelProviders.defaults.disabled") },
              ...options,
            ],
            disabled: modelControlsDisabled || saving,
            title,
            showSelectedDetail: true,
            onChange: (value) =>
              props.onUtilityChange(value === AUTOMATIC_UTILITY_VALUE ? null : value),
          }),
        })}
      `,
    )}
    ${renderSettingsSection(
      {
        title: renderSettingsInfoTitle({
          title: t("chat.modelControls.decisionSection"),
          label: t("chat.modelControls.decisionHelpLabel"),
          triggerId: "model-providers-decision-help",
          body: html`<p>${t("chat.modelControls.decisionHelp")}</p>
            <p>${t("chat.modelControls.decisionTaskOnlyHelp")}</p>`,
        }),
      },
      html`
        ${renderDecisionInventory({
          ...props.decisionInventory,
          disabled: !props.canMutate || saving,
          setupError: props.message?.kind === "error" ? props.message.text : undefined,
        })}
        ${renderSettingsRow({
          title: t("chat.modelControls.decisionDefaultLabel"),
          control: renderDecisionModelPicker({
            id: "model-providers-decision-model",
            label: t("chat.modelControls.decisionDefaultLabel"),
            models: props.decisionModels,
            value: props.selection.decisionModel,
            disabled: !props.canMutate || saving,
            title,
            onChange: props.onDecisionChange,
          }),
        })}
        ${renderDecisionTaskRows({
          scope: "global",
          pickerPrefix: "model-providers-decision-task",
          tasks: decisionTaskEntries(props.decisionTasks, props.selection.decisionModelsByTask),
          models: props.decisionModels,
          disabled: !props.canMutate || saving,
          getSelection: (taskId) => resolveGlobalDecisionTaskSelection(props.selection, taskId),
          onChange: (taskId, model) => props.onDecisionTaskChange(taskId, model),
        })}
      `,
    )}
    ${
      props.canMutate && props.message
        ? html`<div
            class="callout ${props.message.kind}"
            role=${props.message.kind === "error" ? "alert" : "status"}
          >
            ${props.message.text}
          </div>`
        : nothing
    }
    ${
      props.canMutate && props.message?.warning
        ? html`<div class="callout warning" role="status">${props.message.warning}</div>`
        : nothing
    }
  `;
}
