import { html, nothing } from "lit";
import { pathForPluginSettings, pathForRoute } from "../../app-route-paths.ts";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import type { DecisionTaskEntry } from "../../components/decision-task-rows.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import { renderSettingsRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type {
  DecisionInventoryEntry,
  DecisionModelUse,
} from "../../lib/decision-model-inventory.ts";

export type DecisionInventoryViewProps = {
  inventory: DecisionInventoryEntry[];
  available: DecisionModelEntry[];
  tasks: DecisionTaskEntry[];
  removeRef: string | null;
  replacement: string;
  disabled: boolean;
  basePath?: string;
  setupError?: string;
  setupRef?: string | null;
  onSetup?: (ref: string | null) => void;
  onAdd: (ref: string) => void;
  onRemove: (ref: string) => void;
  onReplacement: (ref: string) => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
};

function useLabel(use: DecisionModelUse, tasks: readonly DecisionTaskEntry[]): string {
  const scope = use.agentId ?? t("chat.modelControls.decisionGlobalScope");
  const task = use.taskId
    ? (tasks.find((entry) => entry.id === use.taskId)?.title ?? use.taskId)
    : t("chat.modelControls.decisionDefaultLabel");
  return `${scope} · ${task}`;
}

export function renderDecisionInventory(props: DecisionInventoryViewProps) {
  const available = props.available.filter(
    (entry) => !props.inventory.some((model) => model.ref === `${entry.provider}/${entry.id}`),
  );
  return html`
    ${props.inventory.map(
      (model) => html`
        <div data-decision-model-ref=${model.ref}>
          ${renderSettingsRow({
            title: model.name,
            description: model.available ? model.ref : t("chat.modelControls.decisionUnavailable"),
            control: html`<button
              class="btn btn--sm"
              type="button"
              ?disabled=${props.disabled}
              @click=${() => props.onRemove(model.ref)}
            >
              ${t("common.remove")}
            </button>`,
          })}
          ${
            props.removeRef === model.ref
              ? renderSettingsRow({
                  stacked: true,
                  title: t("chat.modelControls.decisionReplaceTitle"),
                  description: html`<p>${t("chat.modelControls.decisionReplaceHelp")}</p>
                    <ul>
                      ${model.uses.map((use) => html`<li>${useLabel(use, props.tasks)}</li>`)}
                    </ul>`,
                  control: html`
                    ${renderModelPicker({
                      id: "decision-model-replacement",
                      label: t("chat.modelControls.decisionReplacement"),
                      value: props.replacement,
                      options: [
                        { value: "", label: t("chat.modelControls.decisionChooseReplacement") },
                        ...props.inventory
                          .filter((candidate) => candidate.ref !== model.ref && candidate.available)
                          .map((candidate) => ({ value: candidate.ref, label: candidate.name })),
                      ],
                      disabled: props.disabled,
                      onChange: props.onReplacement,
                    })}
                    <button
                      id="decision-model-remove-confirm"
                      class="btn btn--sm"
                      type="button"
                      ?disabled=${props.disabled || !props.inventory.some((candidate) => candidate.ref === props.replacement && candidate.ref !== model.ref && candidate.available)}
                      @click=${props.onConfirmRemove}
                    >
                      ${t("chat.modelControls.decisionReplaceRemove")}
                    </button>
                    <button
                      id="decision-model-remove-cancel"
                      class="btn btn--sm"
                      type="button"
                      ?disabled=${props.disabled}
                      @click=${props.onCancelRemove}
                    >
                      ${t("common.cancel")}
                    </button>
                  `,
                })
              : nothing
          }
        </div>
      `,
    )}
    ${renderSettingsRow({
      title: t("chat.modelControls.decisionAddModel"),
      description: t("chat.modelControls.decisionSetupIntro"),
      control: html`<button
        id="decision-model-add"
        class="btn btn--sm"
        type="button"
        ?disabled=${props.disabled}
        @click=${() => props.onSetup?.("")}
      >
        ${t("chat.modelControls.decisionAddModel")}
      </button>`,
    })}
    ${
      props.setupRef !== null && props.setupRef !== undefined
        ? html` <openclaw-modal-dialog
            label=${t("chat.modelControls.decisionAddModel")}
            @modal-cancel=${() => props.onSetup?.(null)}
          >
            <div class="model-setup-wizard">
              <div class="model-setup-wizard__header">
                <h2>${t("chat.modelControls.decisionAddModel")}</h2>
              </div>
              <div class="model-setup-wizard__body">
                <p>${t("chat.modelControls.decisionSetupIntro")}</p>
                ${props.setupError ? html`<div class="callout error" role="alert">${props.setupError}</div>` : nothing}
                ${renderModelPicker({
                  id: "decision-model-setup-choice",
                  label: t("chat.modelControls.decisionChooseModel"),
                  value: props.setupRef,
                  options: [
                    { value: "", label: t("chat.modelControls.decisionChooseModel") },
                    ...available.map((model) => ({
                      value: `${model.provider}/${model.id}`,
                      label: model.name,
                      provider: model.provider,
                    })),
                  ],
                  disabled: props.disabled || available.length === 0,
                  onChange: (ref) => props.onSetup?.(ref),
                })}
                ${renderSetupInstructions(props, available)}
              </div>
              <div class="model-setup-wizard__footer">
                <button
                  class="btn"
                  type="button"
                  ?disabled=${props.disabled}
                  @click=${() => props.onSetup?.(null)}
                >
                  ${t("common.cancel")}
                </button>
                <button
                  id="decision-model-add-confirm"
                  class="btn primary"
                  type="button"
                  ?disabled=${props.disabled || !available.some((model) => `${model.provider}/${model.id}` === props.setupRef)}
                  @click=${() => props.setupRef && props.onAdd(props.setupRef)}
                >
                  ${t("chat.modelControls.decisionRegisterModel")}
                </button>
              </div>
            </div>
          </openclaw-modal-dialog>`
        : nothing
    }
  `;
}

function renderSetupInstructions(props: DecisionInventoryViewProps, models: DecisionModelEntry[]) {
  const model = models.find((entry) => `${entry.provider}/${entry.id}` === props.setupRef);
  return html`
    <p>${t("chat.modelControls.decisionSetupProviderHelp")}</p>
    <a
      class="btn"
      id="decision-model-configure-provider"
      target="_blank"
      rel="noopener noreferrer"
      href=${
        model?.pluginId
          ? `${pathForPluginSettings(model.pluginId, props.basePath)}?view=settings`
          : pathForRoute("plugin-settings", props.basePath)
      }
    >
      ${t(model ? "chat.modelControls.decisionConfigureProvider" : "chat.modelControls.decisionBrowseProviders")}
    </a>
    <p class="muted">${t("chat.modelControls.decisionSetupReturn")}</p>
  `;
}
