// Control UI view renders agents panels overview screen content.
import { html, nothing } from "lit";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import {
  buildModelOptions,
  normalizeModelValue,
  parseFallbackList,
  resolveAgentConfig,
  resolveAgentRuntimeLabel,
  resolveAgentTextAvatar,
  resolveModelFallbacks,
  resolveModelLabel,
  resolveModelPrimary,
} from "../../lib/agents/display.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";

export type AgentIdentityDraft = {
  name: string | null;
  emoji: string | null;
  avatar: string | null;
};

export function renderAgentOverview(params: {
  agent: AgentsListResult["agents"][number];
  basePath: string;
  defaultId: string | null;
  configForm: Record<string, unknown> | null;
  agentFilesList: AgentsFilesListResult | null;
  agentIdentity: AgentIdentityResult | null;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  identityDraft: AgentIdentityDraft;
  identitySaving: boolean;
  identityError: string | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  modelCatalog: ModelCatalogEntry[];
  onConfigReload: () => void;
  onConfigSave: () => void;
  onIdentityFieldChange: (field: "name" | "emoji", value: string) => void;
  onIdentityAvatarSelect: (file: File) => void;
  onIdentitySave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
}) {
  const {
    agent,
    configForm,
    agentFilesList,
    configLoading,
    configSaving,
    configDirty,
    onConfigReload,
    onConfigSave,
    onModelChange,
    onModelFallbacksChange,
    onSelectPanel,
  } = params;
  const isDefault = Boolean(params.defaultId && agent.id === params.defaultId);
  const config = resolveAgentConfig(configForm, agent.id);
  const agentModel = agent.model;
  const workspaceFromFiles =
    agentFilesList && agentFilesList.agentId === agent.id ? agentFilesList.workspace : null;
  const workspace =
    workspaceFromFiles ||
    config.entry?.workspace ||
    config.defaults?.workspace ||
    agent.workspace ||
    "default";
  const model = config.entry?.model
    ? resolveModelLabel(config.entry?.model)
    : config.defaults?.model
      ? resolveModelLabel(config.defaults?.model)
      : resolveModelLabel(agentModel);
  const runtime = resolveAgentRuntimeLabel(agent.agentRuntime);
  const defaultModel = resolveModelLabel(config.defaults?.model ?? agentModel);
  const entryPrimary = resolveModelPrimary(config.entry?.model);
  const defaultPrimary =
    resolveModelPrimary(config.defaults?.model) ||
    (defaultModel !== "-" ? normalizeModelValue(defaultModel) : null) ||
    (configForm ? null : resolveModelPrimary(agentModel));
  const effectivePrimary = entryPrimary ?? defaultPrimary ?? null;
  const selectedPrimary = isDefault ? effectivePrimary : entryPrimary;
  const modelFallbacks =
    resolveModelFallbacks(config.entry?.model) ??
    resolveModelFallbacks(config.defaults?.model) ??
    (configForm ? null : resolveModelFallbacks(agentModel));
  const fallbackChips = modelFallbacks ?? [];
  const skillFilter = Array.isArray(config.entry?.skills) ? config.entry?.skills : null;
  const skillCount = skillFilter?.length ?? null;
  const disabled = !configForm || configLoading || configSaving;
  const thinkingDefault = agent.thinkingDefault ?? "-";

  const identityDraft = params.identityDraft;
  const identityName =
    identityDraft.name ?? params.agentIdentity?.name ?? agent.identity?.name ?? agent.name ?? "";
  const identityEmoji =
    identityDraft.emoji ?? params.agentIdentity?.emoji ?? agent.identity?.emoji ?? "";
  const identityAvatarUrl =
    identityDraft.avatar ?? resolveAgentAvatarUrl(agent, params.agentIdentity);
  const identityAvatarText =
    resolveAgentTextAvatar(agent) ?? (identityName || agent.id).slice(0, 1).toUpperCase();
  const identityDirty =
    identityDraft.name !== null || identityDraft.emoji !== null || identityDraft.avatar !== null;
  const identityInvalid =
    (identityDraft.name !== null && !identityDraft.name.trim()) ||
    (identityDraft.emoji !== null && !identityDraft.emoji.trim());
  const identityBusy = params.identitySaving;

  const handleAvatarFileSelect = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file) {
      params.onIdentityAvatarSelect(file);
    }
  };

  const removeChip = (index: number) => {
    const next = fallbackChips.filter((_, i) => i !== index);
    onModelFallbacksChange(agent.id, next);
  };

  const handleChipKeydown = (e: KeyboardEvent) => {
    const input = e.target as HTMLInputElement;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const parsed = parseFallbackList(input.value);
      if (parsed.length > 0) {
        onModelFallbacksChange(agent.id, [...fallbackChips, ...parsed]);
        input.value = "";
      }
    }
  };

  return html`
    <section class="card">
      <div class="card-title">${t("agents.identity.title")}</div>
      <div class="card-sub">${t("agents.identity.subtitle")}</div>

      <div class="agent-identity-editor">
        <span class="agent-identity-editor__avatar" aria-hidden="true">
          ${identityAvatarUrl
            ? html`<img src=${identityAvatarUrl} alt="" decoding="async" />`
            : html`<span class="agent-identity-editor__avatar-text">${identityAvatarText}</span>`}
        </span>
        <div class="agent-identity-editor__fields">
          <label class="field">
            <span>${t("agents.identity.name")}</span>
            <input
              type="text"
              maxlength="64"
              .value=${identityName}
              placeholder=${t("agents.identity.namePlaceholder")}
              ?disabled=${identityBusy}
              @input=${(e: Event) =>
                params.onIdentityFieldChange("name", (e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="field agent-identity-editor__emoji">
            <span>${t("agents.identity.emoji")}</span>
            <input
              type="text"
              maxlength="8"
              .value=${identityEmoji}
              placeholder="🦞"
              ?disabled=${identityBusy}
              @input=${(e: Event) =>
                params.onIdentityFieldChange("emoji", (e.target as HTMLInputElement).value)}
            />
          </label>
        </div>
      </div>

      ${params.identityError
        ? html`<div class="callout danger" style="margin-top: 12px;">${params.identityError}</div>`
        : nothing}

      <div class="agent-model-actions" style="margin-top: 12px;">
        <label class="btn btn--sm">
          ${identityAvatarUrl
            ? t("agents.identity.replaceImage")
            : t("agents.identity.chooseImage")}
          <input
            type="file"
            accept="image/*"
            hidden
            ?disabled=${identityBusy}
            @change=${handleAvatarFileSelect}
          />
        </label>
        <button
          type="button"
          class="btn btn--sm primary"
          ?disabled=${identityBusy || !identityDirty || identityInvalid}
          @click=${() => params.onIdentitySave()}
        >
          ${identityBusy ? t("common.saving") : t("common.save")}
        </button>
      </div>
      <div class="muted agent-identity-editor__hint">${t("agents.identity.fileHint")}</div>
    </section>

    <section class="card">
      <div class="card-title">${t("agents.overview.title")}</div>
      <div class="card-sub">${t("agents.overview.subtitle")}</div>

      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">${t("agents.context.workspace")}</div>
          <div>
            <openclaw-tooltip .content=${t("agents.context.openFilesTab")}>
              <button
                type="button"
                class="workspace-link mono"
                @click=${() => onSelectPanel("files")}
                aria-label=${t("agents.context.openFilesTab")}
              >
                ${workspace}
              </button>
            </openclaw-tooltip>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agents.context.primaryModel")}</div>
          <div class="mono">${model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agents.context.runtime")}</div>
          <div class="mono">${runtime}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agents.context.thinkingDefault")}</div>
          <div class="mono">${thinkingDefault}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agents.context.skillsFilter")}</div>
          <div>
            ${skillFilter
              ? t("agents.overview.selectedSkills", { count: String(skillCount) })
              : t("agents.overview.allSkills")}
          </div>
        </div>
      </div>

      ${configDirty
        ? html`
            <div class="callout warn" style="margin-top: 16px">
              ${t("agents.overview.unsavedConfig")}
            </div>
          `
        : nothing}

      <div class="agent-model-select" style="margin-top: 20px;">
        <div class="label">${t("agents.overview.modelSelection")}</div>
        <div class="agent-model-fields">
          <label class="field">
            <span>
              ${isDefault
                ? t("agents.overview.primaryModelDefault")
                : t("agents.overview.primaryModel")}
            </span>
            <select
              .value=${selectedPrimary ?? ""}
              ?disabled=${disabled}
              @change=${(e: Event) =>
                onModelChange(agent.id, (e.target as HTMLSelectElement).value || null)}
            >
              ${isDefault
                ? html`
                    <option value="" ?selected=${!selectedPrimary}>
                      ${t("agents.overview.notSet")}
                    </option>
                  `
                : html`
                    <option value="" ?selected=${!selectedPrimary}>
                      ${defaultPrimary
                        ? t("agents.overview.inheritDefaultModel", { model: defaultPrimary })
                        : t("agents.overview.inheritDefault")}
                    </option>
                  `}
              ${buildModelOptions(
                configForm,
                effectivePrimary ?? undefined,
                params.modelCatalog,
                selectedPrimary,
              )}
            </select>
          </label>
          <div class="field">
            <span>${t("agents.overview.fallbacks")}</span>
            <div
              class="agent-chip-input"
              @click=${(e: Event) => {
                const container = e.currentTarget as HTMLElement;
                const input = container.querySelector("input");
                if (input) {
                  input.focus();
                }
              }}
            >
              ${fallbackChips.map(
                (chip, i) => html`
                  <span class="chip">
                    ${chip}
                    <button
                      type="button"
                      class="chip-remove"
                      ?disabled=${disabled}
                      @click=${() => removeChip(i)}
                    >
                      &times;
                    </button>
                  </span>
                `,
              )}
              <input
                ?disabled=${disabled}
                placeholder=${fallbackChips.length === 0 ? "provider/model" : ""}
                @keydown=${handleChipKeydown}
                @blur=${(e: Event) => {
                  const input = e.target as HTMLInputElement;
                  const parsed = parseFallbackList(input.value);
                  if (parsed.length > 0) {
                    onModelFallbacksChange(agent.id, [...fallbackChips, ...parsed]);
                    input.value = "";
                  }
                }}
              />
            </div>
          </div>
        </div>
        <div class="agent-model-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${configLoading}
            @click=${onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${configSaving || !configDirty}
            @click=${onConfigSave}
          >
            ${configSaving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </section>
  `;
}
