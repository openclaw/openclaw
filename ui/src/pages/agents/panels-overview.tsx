import { createMemo, createUniqueId, For, onSettled, Show } from "solid-js";
import { normalizeAgentModelRefForConfig } from "../../../../src/config/model-input.js";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
} from "../../api/types.ts";
import { AgentEmojiPicker } from "../../components/agent-emoji-picker.tsx";
import { MultiSelect } from "../../components/multi-select.tsx";
import { createOverlayAnchor } from "../../components/overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../../components/overlay-lifecycle.ts";
import "../../components/tooltip.ts";
import { DecisionModelPicker } from "../../components/solid/decision-model-picker.tsx";
import { AgentIdentityAvatar } from "../../components/solid/identity-avatar.tsx";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import { PanelRefreshStatus as PanelRefreshNotice } from "../../components/solid/panel-refresh-status.tsx";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { StrokeIcon } from "../../components/solid/stroke-icon.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import "../../components/solid/overlay.css";
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
import { createIdentityAvatars } from "../../lib/identity-avatar-loader.ts";
import { projectApplicationConfig } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AvatarPicker } from "./avatar-picker.tsx";
import { AgentConfigButtons, type AgentConfigActions } from "./config-actions.tsx";
import { renderAgentPanelFacts } from "./panel-ui.tsx";

registerEnglishCatalog(registerSettingsEnglish);

export function AgentOverview(
  params: AgentConfigActions &
    Omit<AgentsPageView["overview"], "modelSelectionPolicy" | "modelCatalogRetired"> &
    Partial<Pick<AgentsPageView["overview"], "modelSelectionPolicy" | "modelCatalogRetired">> &
    Pick<AgentsPageView, "readData"> & {
      agent: AgentsListResult["agents"][number];
      defaultId: string | null;
      configForm: Record<string, unknown> | null;
      agentFilesList: AgentsFilesListResult | null;
      agentIdentity: AgentIdentityResult | null;
      canUpdateIdentity: boolean;
      onSelectPanel: (panel: AgentsPanel) => void;
    },
) {
  const applicationConfig = useOptionalApplication()?.config;
  const configProjection = applicationConfig
    ? projectApplicationConfig(applicationConfig)
    : undefined;
  const uploadsEnabled = () => configProjection?.read().uploadsEnabled !== false;
  const avatarLoader = createIdentityAvatars();
  onSettled(() => avatarLoader.connect());
  const avatarProjection = projectOwner(avatarLoader, (owner) => owner);
  const catalogOwnsChoices = createMemo(
    () => params.modelCatalogRetired || params.modelSelectionPolicy?.restricted,
  );
  const configForm = () => (catalogOwnsChoices() ? null : params.configForm);
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
  const primaryModelLabel = () => t(`agents.overview.primaryModel${isDefault() ? "Default" : ""}`);
  const config = createMemo(() => resolveAgentConfig(configForm(), params.agent.id));
  const agentModel = () => visibleAgent().model;
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
  const primaryModelOptions = createMemo(() => {
    const inherited = defaultPrimary();
    return [
      {
        value: "",
        label: isDefault()
          ? t("agents.overview.notSet")
          : inherited
            ? t("agents.overview.inheritDefaultModel", { model: inherited })
            : t("agents.overview.inheritDefault"),
      },
      ...buildModelOptions(
        configForm(),
        effectivePrimary() ?? undefined,
        params.modelCatalog,
        params.agent.id,
      ),
    ];
  });
  const decisionModel = createMemo(() => {
    const value = config().entry?.decisionModel;
    return typeof value === "string" ? value : undefined;
  });
  const inheritedDecisionModel = createMemo(() => {
    const value = config().defaults?.decisionModel;
    return typeof value === "string" ? value : undefined;
  });
  const modelFallbacks = createMemo(
    () =>
      resolveEffectiveModelFallbacks(config().entry?.model, config().defaults?.model) ??
      (configForm() ? null : resolveModelFallbacks(agentModel())),
  );
  const fallbackChips = createMemo(() => modelFallbacks() ?? []);
  const disabled = createMemo(
    () => !params.canUpdateConfig || !configForm() || params.configLoading || params.configSaving,
  );
  const identityDraft = () => params.readData().identityDraft;
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
    const source = persistedAvatarUrl();
    const draftAvatar = identityDraft().avatar;
    return avatarProjection
      .read()
      .withActiveRoutes(() => draftAvatar ?? (source ? avatarLoader.resolve(source) : null));
  });
  const identityImageError = createMemo(() => {
    identityAvatarUrl();
    const source = persistedAvatarUrl();
    return source ? avatarLoader.imageErrorHandler(source) : undefined;
  });
  const identityBusy = createMemo(() => !params.canUpdateIdentity);
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

  const avatarPickerId = `agent-avatar-picker-${createUniqueId()}`;
  const avatarOverlay = createOverlay(avatarPickerId, undefined, {
    exclusiveGroup: "menu",
  });
  const avatarPickerOpen = projectOwner(avatarOverlay, (overlay) => overlay.open).read;
  const pickerContentVisible = createMemo(() => avatarPickerOpen() && uploadsEnabled());
  let avatarTrigger: HTMLButtonElement | undefined;
  let avatarSurface: HTMLDivElement | undefined;
  onSettled(() => {
    if (!avatarTrigger || !avatarSurface) {
      return () => avatarOverlay.dispose();
    }
    avatarOverlay.bindSurface(avatarSurface);
    avatarOverlay.bindTrigger(avatarTrigger);
    avatarOverlay.setParent(findOverlayParent(avatarTrigger));
    const anchor = createOverlayAnchor(avatarSurface, { sameRoot: true });
    anchor.update(avatarTrigger, "right-start");
    // Retire the native overlay synchronously when upload authority is revoked.
    const unsubscribeConfig = applicationConfig?.subscribe((nextConfig) => {
      if (!nextConfig.uploadsEnabled) {
        avatarOverlay.request(false);
      }
    });
    return () => {
      unsubscribeConfig?.();
      anchor.dispose();
      avatarOverlay.dispose();
    };
  });
  const renderIdentityAvatar = () => (
    <AgentIdentityAvatar
      agent={{
        id: params.agent.id,
        avatar: identityAvatarUrl(),
        textAvatar:
          identityDraft().emoji ?? resolveAgentTextAvatar(params.agent, params.agentIdentity),
      }}
      onImageError={identityImageError()}
    />
  );

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
            <button
              ref={(element) => (avatarTrigger = element)}
              type="button"
              class="agent-identity-editor__avatar"
              aria-label={t("agents.identity.chooseAvatar")}
              aria-expanded={avatarPickerOpen() ? "true" : "false"}
              aria-controls={avatarPickerId}
              disabled={identityBusy() || !uploadsEnabled()}
              onClick={() => avatarOverlay.request(!avatarOverlay.open)}
            >
              {renderIdentityAvatar()}
              <span class="agent-identity-editor__avatar-edit" aria-hidden="true">
                <StrokeIcon>
                  <path d="m16 5 3 3M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" />
                </StrokeIcon>
              </span>
            </button>
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
                    onBlur={() => params.onIdentitySave()}
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
                      onBlur={() => params.onIdentitySave()}
                    />
                    <AgentEmojiPicker
                      value={identityEmoji()}
                      disabled={identityBusy()}
                      onSelect={(emoji: string) =>
                        params.onIdentityFieldChange("emoji", limitEmoji(emoji))
                      }
                    />
                  </div>
                </div>
              </div>
              {params.readData().identityError ? (
                <div class="settings-row__desc" role="alert" style={{ color: "var(--danger)" }}>
                  {params.readData().identityError}
                </div>
              ) : undefined}
            </div>
            <div
              ref={(element) => (avatarSurface = element)}
              id={avatarPickerId}
              class="oc-overlay agent-identity-editor__popover"
              popover="manual"
              role="dialog"
              aria-label={t("agents.identity.avatarPicker")}
            >
              <Show when={pickerContentVisible()}>
                <For each={[`${params.agent.id}:${params.readData().requestGeneration}`]}>
                  {() => (
                    <AvatarPicker
                      agentId={params.agent.id}
                      avatar={identityAvatarUrl()}
                      disabled={identityBusy()}
                      onSelect={(dataUrl) => {
                        params.onIdentityAvatarSet(dataUrl);
                        avatarOverlay.request(false, "return");
                      }}
                      onUpload={(file) => {
                        params.onIdentityAvatarSelect(file);
                        avatarOverlay.request(false, "return");
                      }}
                      onGenerate={(prompt) => params.onIdentityAvatarGenerate(prompt)}
                    />
                  )}
                </For>
              </Show>
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
          ["agents.context.thinkingDefault", <code>{params.agent.thinkingDefault ?? "-"}</code>],
          ["agents.context.skillsFilter", context().skillsLabel],
        ])}
      </SettingsSection>
      {params.configDirty ? (
        <div class="callout warn">{t("agents.overview.unsavedConfig")}</div>
      ) : undefined}
      <SettingsSection
        title={t("agents.overview.modelSelection")}
        notice={<PanelRefreshNotice status={params.readData().chatModelCatalogStatus} />}
        actions={<AgentConfigButtons {...params} buttonType="button" />}
      >
        <SettingsRow
          title={primaryModelLabel()}
          control={
            <ModelPicker
              label={primaryModelLabel()}
              value={selectedPrimary() ?? ""}
              options={primaryModelOptions()}
              disabled={disabled()}
              onChange={(value) => params.onModelChange(params.agent.id, value || null)}
              onOpen={params.onModelCatalogOpen}
            />
          }
        />
        <SettingsRow
          title={t("chat.modelControls.decisionLabel")}
          description={t("chat.modelControls.decisionAgentHelp")}
          control={
            <DecisionModelPicker
              id="agent-decision-model"
              models={params.decisionModels}
              value={decisionModel()}
              inherit={{ model: inheritedDecisionModel() }}
              disabled={disabled()}
              onChange={(value) => params.onDecisionModelChange(params.agent.id, value)}
              onOpen={params.onModelCatalogOpen}
            />
          }
        />
        <SettingsRow
          title={t("agents.overview.fallbacks")}
          stacked={true}
          control={
            <MultiSelect
              class="agent-fallbacks"
              options={fallbackOptions()}
              value={fallbackChips()}
              isExcluded={isPrimaryModel()}
              getValueKey={normalizeAgentModelRefForConfig}
              placeholder={t("agents.overview.addFallback")}
              accessibleLabel={t("agents.overview.fallbacks")}
              allowCustom={!catalogOwnsChoices()}
              disabled={disabled()}
              onChange={(next: string[]) => params.onModelFallbacksChange(params.agent.id, next)}
              onOpen={params.onModelCatalogOpen}
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
