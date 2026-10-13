import type { JSX } from "@solidjs/web";
import { createMemo, onCleanup } from "solid-js";
import { normalizeAgentModelRefForConfig } from "../../../../src/config/model-input.js";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
  ModelCatalogResult,
} from "../../api/types.ts";
import "../../components/agent-emoji-picker.ts";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import {
  renderDecisionModelPicker,
  type DecisionModelEntry,
} from "../../components/decision-model-picker.ts";
import "../../components/multi-select-registration.ts";
import { renderAgentIdentityAvatar } from "../../components/identity-avatar-view.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import "../../components/tooltip.ts";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status-state.ts";
import { PanelRefreshStatus as PanelRefreshNotice } from "../../components/solid/panel-refresh-status.tsx";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import {
  type AgentContext,
  buildAgentContext,
  buildModelOptions,
  createPrimaryModelExclusion,
  resolveAgentConfig,
  resolveAgentTextAvatar,
  resolveEffectiveModelFallbacks,
  resolveModelFallbacks,
  resolveModelPrimary,
} from "../../lib/agents/display.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { uploadsEnabled } from "../../lib/uploads.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { ControllerHost } from "../../lit/subscriptions-controller.ts";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";
import { renderAgentPanelFacts } from "./panel-ui.tsx";

export type AgentIdentityDraft = {
  name: string | null;
  emoji: string | null;
  avatar: string | null;
};

export function AgentOverview(
  params: AgentConfigActions & {
    applicationConfig?: ApplicationConfigCapability;
    agent: AgentsListResult["agents"][number];
    defaultId: string | null;
    configForm: Record<string, unknown> | null;
    agentFilesList: AgentsFilesListResult | null;
    agentIdentity: AgentIdentityResult | null;
    identityDraft: AgentIdentityDraft;
    identitySaving: boolean;
    identityError: string | null;
    canUpdateIdentity: boolean;
    modelCatalog: ModelCatalogEntry[];
    modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
    modelCatalogRetired?: boolean;
    decisionModels: DecisionModelEntry[];
    modelCatalogStatus: PanelRefreshStatus;
    onIdentityFieldChange: (field: "name" | "emoji", value: string) => void;
    onIdentityAvatarSelect: (file: File) => void;
    onIdentitySave: () => void;
    onModelChange: (agentId: string, modelId: string | null) => void;
    onDecisionModelChange: (agentId: string, modelId: string | null) => void;
    onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
    onModelCatalogOpen: () => void;
    onSelectPanel: (panel: AgentsPanel) => void;
  },
) {
  const avatarHost = new ControllerHost();
  const avatarLoader = new IdentityAvatarController(avatarHost);
  avatarHost.connect();
  onCleanup(() => avatarHost.disconnect());
  const avatarProjection = projectSource(avatarHost, {
    read: (host) => host,
    subscribe: (host, notify) => host.subscribe(notify),
    equality: "revision",
  });
  const catalogOwnsChoices = createMemo(
    () => params.modelCatalogRetired || params.modelSelectionPolicy?.restricted,
  );
  const configForm = createMemo(() => (catalogOwnsChoices() ? null : params.configForm), {
    equals: false,
  });
  const visibleAgent = createMemo(
    () =>
      catalogOwnsChoices()
        ? {
            ...params.agent,
            model: params.modelSelectionPolicy?.defaultModel
              ? { primary: params.modelSelectionPolicy.defaultModel }
              : undefined,
          }
        : params.agent,
    { equals: false },
  );
  const context = createMemo(() =>
    buildAgentContext(
      visibleAgent(),
      configForm(),
      params.agentFilesList,
      params.defaultId,
      params.agentIdentity,
    ),
  );
  const isDefault = createMemo(() => context().isDefault);
  const primaryModelLabel = createMemo(() =>
    t(`agents.overview.primaryModel${isDefault() ? "Default" : ""}`),
  );
  const config = createMemo(() => resolveAgentConfig(configForm(), params.agent.id));
  const agentModel = createMemo(() => visibleAgent().model, { equals: false });
  const entryPrimary = createMemo(() => resolveModelPrimary(config().entry?.model));
  const inheritedPrimary = createMemo(() =>
    resolveModelPrimary(config().defaults?.model ?? agentModel()),
  );
  const defaultPrimary = createMemo(
    () =>
      resolveModelPrimary(config().defaults?.model) ||
      (inheritedPrimary() !== "-" ? inheritedPrimary() : null) ||
      (configForm() ? null : resolveModelPrimary(agentModel())),
  );
  const effectivePrimary = createMemo(() => entryPrimary() ?? defaultPrimary() ?? null);
  const selectedPrimary = createMemo(() => (isDefault() ? effectivePrimary() : entryPrimary()));
  const modelFallbacks = createMemo(
    () =>
      resolveEffectiveModelFallbacks(config().entry?.model, config().defaults?.model) ??
      (configForm() ? null : resolveModelFallbacks(agentModel())),
  );
  const fallbackChips = createMemo(() => modelFallbacks() ?? []);
  const disabled = createMemo(
    () => !params.canUpdateConfig || !configForm() || params.configLoading || params.configSaving,
  );
  const thinkingDefault = createMemo(() => params.agent.thinkingDefault ?? "-");

  const identityDraft = createMemo(() => params.identityDraft, { equals: false });
  const identityName = createMemo(
    () =>
      identityDraft().name ??
      params.agentIdentity?.name ??
      params.agent.identity?.name ??
      params.agent.name ??
      "",
  );
  const identityEmoji = createMemo(
    () =>
      identityDraft().emoji ?? params.agentIdentity?.emoji ?? params.agent.identity?.emoji ?? "",
  );
  // Upload previews are local data URLs; persisted avatars live on a protected
  // Gateway route and must resolve through the authenticated image lease.
  const persistedAvatarUrl = createMemo(() =>
    identityDraft().avatar ? null : resolveAgentAvatarUrl(params.agent, params.agentIdentity),
  );
  const identityAvatarUrl = createMemo(() => {
    avatarProjection.revision();
    const source = persistedAvatarUrl();
    const draftAvatar = identityDraft().avatar;
    return avatarLoader.withActiveRoutes(
      () => draftAvatar ?? (source ? avatarLoader.resolve(source) : null),
    );
  });
  const identityImageError = createMemo(() => {
    identityAvatarUrl();
    const source = persistedAvatarUrl();
    return source ? avatarLoader.imageErrorHandler(source) : undefined;
  });
  const identityDirty = createMemo(
    () =>
      identityDraft().name !== null ||
      identityDraft().emoji !== null ||
      identityDraft().avatar !== null,
  );
  const identityInvalid = createMemo(() => {
    const draft = identityDraft();
    return (
      (draft.name !== null && !draft.name.trim()) || (draft.emoji !== null && !draft.emoji.trim())
    );
  });
  const identityBusy = createMemo(() => params.identitySaving || !params.canUpdateIdentity);
  const limitEmoji = (value: string) => {
    let result = "";
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      value,
    )) {
      if (result && result.length + segment.length > 8) {
        break;
      }
      if (!result && segment.length > 8) {
        return segment;
      }
      result += segment;
    }
    return result;
  };

  const handleAvatarFileSelect: JSX.EventHandler<HTMLInputElement, Event> = (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (file && uploadsEnabled(params.applicationConfig)) {
      params.onIdentityAvatarSelect(file);
    }
  };

  // Same catalog the primary picker offers; the field hides the effective
  // primary and current chain itself. Order is preserved: a pick appends.
  const fallbackOptions = createMemo(() =>
    buildModelOptions(configForm(), null, params.modelCatalog, params.agent.id),
  );
  const isPrimaryModel = createMemo(() =>
    createPrimaryModelExclusion(configForm(), effectivePrimary(), params.agent.id),
  );

  return (
    <>
      <SettingsSection
        title={t("agents.identity.title")}
        description={t("agents.identity.subtitle")}
      >
        <div class="settings-row settings-row--stacked">
          <div class="agent-identity-editor">
            <span class="agent-identity-editor__avatar" aria-hidden="true">
              <LitContent
                render={() =>
                  renderAgentIdentityAvatar(
                    {
                      id: params.agent.id,
                      avatar: identityAvatarUrl(),
                      textAvatar:
                        identityDraft().emoji ??
                        resolveAgentTextAvatar(params.agent, params.agentIdentity),
                    },
                    "",
                    identityImageError(),
                  )
                }
              />
            </span>
            <div class="agent-identity-editor__content">
              <div class="agent-identity-editor__fields">
                <label class="field">
                  <span>{t("agents.identity.name")}</span>
                  <input
                    type="text"
                    maxlength="64"
                    value={identityName()}
                    placeholder={t("agents.identity.namePlaceholder")}
                    disabled={identityBusy()}
                    onInput={(event) =>
                      params.onIdentityFieldChange("name", event.currentTarget.value)
                    }
                  />
                </label>
                <div class="field agent-identity-editor__emoji">
                  <span>{t("agents.identity.emoji")}</span>
                  <div class="agent-identity-editor__emoji-control">
                    <input
                      type="text"
                      maxlength="64"
                      aria-label={t("agents.identity.emoji")}
                      value={identityEmoji()}
                      disabled={identityBusy()}
                      onInput={(event: Event) => {
                        if (event.currentTarget instanceof HTMLInputElement) {
                          const emoji = limitEmoji(event.currentTarget.value);
                          event.currentTarget.value = emoji;
                          params.onIdentityFieldChange("emoji", emoji);
                        }
                      }}
                    />
                    <openclaw-agent-emoji-picker
                      prop:value={identityEmoji()}
                      prop:disabled={identityBusy()}
                      prop:onSelect={(emoji: string) =>
                        params.onIdentityFieldChange("emoji", limitEmoji(emoji))
                      }
                    />
                  </div>
                </div>
              </div>
              {params.identityError ? (
                <div class="settings-row__desc" role="alert" style={{ color: "var(--danger)" }}>
                  {params.identityError}
                </div>
              ) : undefined}
              <div class="agent-identity-editor__actions">
                {uploadsEnabled(params.applicationConfig) ? (
                  <>
                    <button
                      type="button"
                      class="btn btn--sm"
                      disabled={identityBusy()}
                      onClick={(event: Event) => {
                        const button = event.currentTarget;
                        const input =
                          button instanceof HTMLButtonElement ? button.nextElementSibling : null;
                        if (
                          uploadsEnabled(params.applicationConfig) &&
                          input instanceof HTMLInputElement
                        ) {
                          input.click();
                        }
                      }}
                    >
                      {identityAvatarUrl()
                        ? t("agents.identity.replaceImage")
                        : t("agents.identity.chooseImage")}
                    </button>
                    <input
                      type="file"
                      accept="image/*"
                      hidden
                      disabled={identityBusy()}
                      onChange={handleAvatarFileSelect}
                    />
                  </>
                ) : undefined}
                <button
                  type="button"
                  class="btn btn--sm primary"
                  disabled={
                    identityBusy() ||
                    !identityDirty() ||
                    identityInvalid() ||
                    (identityDraft().avatar !== null && !uploadsEnabled(params.applicationConfig))
                  }
                  onClick={() => params.onIdentitySave()}
                >
                  {params.identitySaving ? t("common.saving") : t("common.save")}
                </button>
              </div>
              <div class="settings-row__desc agent-identity-editor__hint">
                {uploadsEnabled(params.applicationConfig)
                  ? t("agents.identity.fileHint")
                  : undefined}
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("agents.overview.title")}
        description={t("agents.overview.subtitle")}
      >
        {renderAgentPanelFacts([
          [
            "agents.context.workspace",
            <openclaw-tooltip prop:content={t("agents.context.openFilesTab")}>
              <button
                type="button"
                class="workspace-link mono"
                onClick={() => params.onSelectPanel("files")}
                aria-label={t("agents.context.openFilesTab")}
              >
                {context().workspace}
              </button>
            </openclaw-tooltip>,
          ],
          ["agents.context.primaryModel", <code>{context().model}</code>],
          ["agents.context.runtime", <code>{context().runtime}</code>],
          ["agents.context.thinkingDefault", <code>{thinkingDefault()}</code>],
          ["agents.context.skillsFilter", context().skillsLabel],
        ])}
      </SettingsSection>
      {params.configDirty ? (
        <div class="callout warn">{t("agents.overview.unsavedConfig")}</div>
      ) : undefined}
      <SettingsSection
        title={t("agents.overview.modelSelection")}
        notice={<PanelRefreshNotice status={params.modelCatalogStatus} />}
        actions={<AgentConfigButtons {...params} buttonType="button" />}
      >
        <SettingsRow
          title={primaryModelLabel()}
          control={
            <LitContent
              render={() => {
                const inherited = defaultPrimary();
                return renderModelPicker({
                  label: primaryModelLabel(),
                  value: selectedPrimary() ?? "",
                  options: [
                    {
                      value: "",
                      label: isDefault()
                        ? t("agents.overview.notSet")
                        : inherited
                          ? t("agents.overview.inheritDefaultModel", {
                              model: inherited,
                            })
                          : t("agents.overview.inheritDefault"),
                    },
                    ...buildModelOptions(
                      configForm(),
                      effectivePrimary() ?? undefined,
                      params.modelCatalog,
                      params.agent.id,
                    ),
                  ],
                  disabled: disabled(),
                  onChange: (value) => params.onModelChange(params.agent.id, value || null),
                  onOpen: params.onModelCatalogOpen,
                });
              }}
            />
          }
        />
        <SettingsRow
          title={t("chat.modelControls.decisionLabel")}
          description={t("chat.modelControls.decisionAgentHelp")}
          control={
            <LitContent
              render={() => {
                const agentConfig = config();
                const decisionModel = agentConfig.entry?.decisionModel;
                const inheritedDecisionModel = agentConfig.defaults?.decisionModel;
                return renderDecisionModelPicker({
                  id: "agent-decision-model",
                  models: params.decisionModels,
                  value: typeof decisionModel === "string" ? decisionModel : undefined,
                  inherit: {
                    model:
                      typeof inheritedDecisionModel === "string"
                        ? inheritedDecisionModel
                        : undefined,
                  },
                  disabled: disabled(),
                  onChange: (value) => params.onDecisionModelChange(params.agent.id, value),
                  onOpen: params.onModelCatalogOpen,
                });
              }}
            />
          }
        />
        <SettingsRow
          title={t("agents.overview.fallbacks")}
          stacked={true}
          control={
            <openclaw-multi-select
              class="agent-fallbacks"
              prop:options={fallbackOptions()}
              prop:value={fallbackChips()}
              prop:isExcluded={isPrimaryModel()}
              prop:getValueKey={normalizeAgentModelRefForConfig}
              prop:placeholder={t("agents.overview.addFallback")}
              prop:accessibleLabel={t("agents.overview.fallbacks")}
              prop:allowCustom={!catalogOwnsChoices()}
              prop:disabled={disabled()}
              prop:onChange={(next: string[]) =>
                params.onModelFallbacksChange(params.agent.id, next)
              }
              prop:onOpen={params.onModelCatalogOpen}
            />
          }
        />
      </SettingsSection>
    </>
  );
}

export function renderAgentContextSection(
  context: AgentContext,
  subtitle: string,
  onSelectPanel: (panel: AgentsPanel) => void,
) {
  return (
    <SettingsSection title={t("agents.context.title")} description={subtitle}>
      {renderAgentPanelFacts([
        [
          "agents.context.workspace",
          <button type="button" class="workspace-link mono" onClick={() => onSelectPanel("files")}>
            {context.workspace}
          </button>,
        ],
        ["agents.context.primaryModel", <code>{context.model}</code>],
        ["agents.context.runtime", <code>{context.runtime}</code>],
        ["agents.context.identityName", context.identityName],
        ["agents.context.identityAvatar", context.identityAvatar],
        ["agents.context.skillsFilter", context.skillsLabel],
        ["agents.context.default", t(context.isDefault ? "common.yes" : "common.no")],
      ])}
    </SettingsSection>
  );
}
