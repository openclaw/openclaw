import { html, nothing, type TemplateResult } from "lit";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { BASE_THINKING_LEVELS } from "../../../../src/auto-reply/thinking.shared.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { FastMode, ModelAuthStatusProvider, ModelAuthStatusResult } from "../../api/types.ts";
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
import { modelCatalogRef, type DefaultModelSelection, type ModelPickerEntry } from "./data.ts";

type DefaultModelsViewProps = {
  models: ModelPickerEntry[];
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
  message?: { kind: "success" | "error"; text: string; warning?: string };
  onPrimaryChange: (model: string) => void;
  onFallbackChange: (model: string | null) => void;
  onUtilityChange: (model: string | null) => void;
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

function renderHelpTitle(params: {
  title: string;
  label: string;
  triggerId: string;
  body: TemplateResult;
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
          <div slot="content" class="settings-section__help-panel">${params.body}</div>
        </openclaw-tooltip>
      </span>
    </span>
  `;
}

function renderDefaultOption(params: { label: string; help: string }): TemplateResult {
  return html`
    <span class="model-providers__segment-label">
      <span>${params.label}</span>
      <openclaw-tooltip open-on-click .content=${params.help}>
        <button
          type="button"
          class="model-providers__segment-info"
          aria-label=${params.help}
          @click=${(event: Event) => event.stopPropagation()}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              event.stopPropagation();
            }
          }}
        >
          ${icons.info}
        </button>
      </openclaw-tooltip>
    </span>
  `;
}

function fastModeOptionValue(value: "auto" | "on" | "off"): FastMode {
  return value === "auto" ? "auto" : value === "on";
}

// Discovery progress does not change the saved selection or disable known models.
function renderCatalogProgress(props: DefaultModelsViewProps): TemplateResult | typeof nothing {
  if (props.catalogDiscovering) {
    return html`
      <div class="model-providers__catalog-progress" role="status" aria-live="polite">
        <span class="btn__spinner" aria-hidden="true"></span>
        <span>${t("modelProviders.defaults.discoveringMore")}</span>
      </div>
    `;
  }
  if (props.catalogDiscoveryError) {
    return html`
      <div class="model-providers__catalog-progress" role="alert" aria-live="polite">
        <span>${t("modelProviders.defaults.discoverFailed")}</span>
        <button class="btn btn--sm" type="button" @click=${props.onCatalogRetry}>
          ${t("modelProviders.defaults.retryDiscover")}
        </button>
      </div>
    `;
  }
  return nothing;
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
        title: renderHelpTitle({
          title: t("modelProviders.defaults.utility"),
          label: t("modelProviders.defaults.utilityHelpLabel"),
          triggerId: UTILITY_MODEL_HELP_ID,
          body: html`
            <p>${t("modelProviders.defaults.utilityHelpPurpose")}</p>
            <p>${t("modelProviders.defaults.utilityHelpAutomatic")}</p>
          `,
        }),
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
        title: renderHelpTitle({
          title: t("quickSettings.model.thinking"),
          label: t("modelProviders.defaults.thinkingHelpLabel"),
          triggerId: THINKING_HELP_ID,
          body: html`<p>${t("modelProviders.defaults.thinkingHelp")}</p>`,
        }),
        control: html`
          ${renderSettingsSegmented({
            value: props.thinkingLevel ?? "",
            options: [
              {
                value: "",
                label: renderDefaultOption({
                  label: t("quickSettings.model.default"),
                  help: t("modelProviders.defaults.thinkingDefaultHelp"),
                }),
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
        title: renderHelpTitle({
          title: t("quickSettings.model.fastMode"),
          label: t("modelProviders.defaults.fastModeHelpLabel"),
          triggerId: FAST_MODE_HELP_ID,
          body: html`<p>${t("modelProviders.defaults.fastModeHelp")}</p>`,
        }),
        control: html`
          ${renderSettingsSegmented<"" | "auto" | "on" | "off">({
            value: fastMode,
            options: [
              {
                value: "",
                label: renderDefaultOption({
                  label: t("quickSettings.model.default"),
                  help: t("modelProviders.defaults.fastModeDefaultHelp"),
                }),
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
      ${renderCatalogProgress(props)}
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
