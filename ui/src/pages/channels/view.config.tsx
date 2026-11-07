import { createMemo, For, Show } from "solid-js";
import { analyzeConfigSchema } from "../../components/config-form.analyze.ts";
import { ConfigNode } from "../../components/config-form.node.tsx";
import { ConfigTierGroups } from "../../components/config-form.render.tsx";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { SettingsLoadingSkeleton } from "../../components/solid/settings-ui.tsx";
import { formatChannelExtraValue, resolveChannelConfigValue } from "../../lib/channels/index.ts";
import { humanize, localizedHintForPath } from "../../lib/config-form-utils.ts";
import { storedSecretSource } from "../../lib/config/stored-secret-source.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { applyChannelConfigEdits } from "./channel-config-draft.ts";
import type { ChannelsProps } from "./view.types.ts";

function resolveSchemaNode(schema: JsonSchema | null, path: string[]): JsonSchema | null {
  let current = schema;
  for (const key of path) {
    if (!current || schemaType(current) !== "object") {
      return null;
    }
    const additional = current.additionalProperties;
    current =
      current.properties?.[key] ||
      (additional && typeof additional === "object" ? additional : null);
  }
  return current;
}

const EXTRA_CHANNEL_FIELDS = ["groupPolicy", "streamMode", "dmPolicy"] as const;

const channelConfigFormId = (channelId: string) => `channel-config-${channelId}`;

function isSavingChannelConfig(channelId: string, props: ChannelsProps) {
  return (
    props.savingChannel === channelId || props.mutationBusy?.config || props.config.configSaving
  );
}

/** A changed field by the name its form row shows. */
function channelConfigFieldLabel(props: ChannelsProps, path: Array<string | number>) {
  const keys = path.filter((segment): segment is string => typeof segment === "string");
  const schema = props.config.configSchema as JsonSchema | null;
  return (
    localizedHintForPath(path, props.config.configUiHints)?.label ??
    resolveSchemaNode(schema, keys)?.title ??
    humanize(keys.at(-1) ?? "")
  );
}

/** Outside the form's scroll, so what happened to a save never depends on scrolling to it. */
export function ChannelConfigFeedback(params: { channelId: string; props: ChannelsProps }) {
  const blockedSetup = () =>
    params.props.wizardHost.blockedByDirtyConfig() &&
    (params.props.config.configFormDirty || Object.keys(params.props.configEdits).length > 0);
  // Only this channel's Save reports here; the shared config error can belong to another page.
  const feedback = () =>
    params.props.saveFeedback?.channelId === params.channelId ? params.props.saveFeedback : null;
  const conflict = () => {
    const current = feedback();
    return current?.kind === "conflict" ? current.paths : null;
  };
  const message = () => {
    const current = feedback();
    return current?.kind === "error"
      ? { danger: true, text: current.message }
      : current?.kind === "notSaved"
        ? { danger: true, text: t("channels.config.saveNotSaved") }
        : current?.kind === "interrupted"
          ? { danger: false, text: t("channels.config.saveInterrupted") }
          : null;
  };
  const busy = () => isSavingChannelConfig(params.channelId, params.props);
  // The settings save indicator's own "changed elsewhere" look: text and actions, no tinted box.
  return (
    <Show when={feedback() || blockedSetup()}>
      <div class="channels-detail__feedback" role="alert">
        <Show when={conflict()}>
          {(paths) => (
            <div class="settings-save-indicator">
              <span class="settings-save-indicator__failure">
                {t("channels.config.conflict", {
                  fields: paths()
                    .map((path) => channelConfigFieldLabel(params.props, path))
                    .join(", "),
                })}
              </span>
              <button
                class="btn btn--xs settings-save-indicator__action"
                type="button"
                disabled={busy()}
                onClick={() => params.props.onConfigConflict(params.channelId, "latest")}
              >
                {t("common.reload")}
              </button>
              <button
                class="btn btn--xs settings-save-indicator__action"
                type="button"
                disabled={busy() || !params.props.channels.connected}
                onClick={() => params.props.onConfigConflict(params.channelId, "keep")}
              >
                {t("agents.files.overwrite")}
              </button>
            </div>
          )}
        </Show>
        <Show when={message()}>
          {(current) => (
            <div class="settings-save-indicator">
              <span
                class={{
                  "settings-save-indicator__failure": current().danger,
                }}
              >
                {current().text}
              </span>
            </div>
          )}
        </Show>
        <Show when={blockedSetup()}>
          <InlineAlert tone="warning" role="none">
            {t("channels.hub.saveBeforeSetup")}
          </InlineAlert>
        </Show>
      </div>
    </Show>
  );
}

/** Leads the dialog's footer: a long form can't hide that an edit is waiting on Save. */
export function ChannelConfigStatus(params: { channelId: string; props: ChannelsProps }) {
  const edits = () => params.props.configEdits[params.channelId];
  const saved = () => params.props.savedChannel === params.channelId;
  return (
    <Show when={edits() || saved()}>
      <span class="channels-detail__status" role="status">
        {t(edits() ? "channels.config.unsaved" : "channels.config.saved")}
      </span>
    </Show>
  );
}

/** Discard and Save close the footer, only while there is something to decide. The form owns
    Save through `form`: wrapping the dialog would make plugin views' own buttons submit it. */
export function ChannelConfigActions(params: { channelId: string; props: ChannelsProps }) {
  const saving = () => isSavingChannelConfig(params.channelId, params.props);
  return (
    <Show when={params.props.configEdits[params.channelId]}>
      {/* One unit, so a narrow footer wraps the decision together instead of splitting it. */}
      <div class="channels-detail__decide">
        <button
          class="btn btn--sm"
          type="button"
          disabled={saving()}
          onClick={() => params.props.onConfigDiscard(params.channelId)}
        >
          {t("channels.config.discard")}
        </button>
        <button
          class="btn btn--sm primary"
          type="submit"
          form={channelConfigFormId(params.channelId)}
          disabled={!params.props.channels.connected || saving()}
        >
          {saving() ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </Show>
  );
}

export function ChannelConfig(params: { channelId: string; props: ChannelsProps }) {
  const analysis = createMemo(() => analyzeConfigSchema(params.props.config.configSchema));
  const node = createMemo(() =>
    resolveSchemaNode(analysis().schema, ["channels", params.channelId]),
  );
  const edits = () => params.props.configEdits[params.channelId];
  const value = createMemo(() =>
    applyChannelConfigEdits(
      resolveChannelConfigValue(params.props.config.configForm ?? {}, params.channelId),
      params.channelId,
      edits() ?? [],
    ),
  );
  // A field the form already edits isn't worth repeating as text below it.
  const extraFields = () =>
    EXTRA_CHANNEL_FIELDS.filter((field) => field in value() && !node()?.properties?.[field]);
  const unsupported = createMemo(() => new Set(analysis().unsupportedPaths));
  const saving = () =>
    params.props.savingChannel === params.channelId ||
    params.props.mutationBusy?.config ||
    params.props.config.configSaving;
  const disabled = createMemo(() => saving() || params.props.config.configSchemaLoading);
  return (
    <Show
      when={!params.props.config.configSchemaLoading}
      fallback={<SettingsLoadingSkeleton label={t("channels.config.loadingSchema")} rows={2} />}
    >
      <form
        id={channelConfigFormId(params.channelId)}
        class="channels-detail__form"
        novalidate
        onSubmit={(event) => {
          event.preventDefault();
          if (event.currentTarget.reportValidity()) {
            params.props.onConfigSave(params.channelId);
          }
        }}
      >
        <Show
          when={node()}
          fallback={
            <div class="settings-row__desc">
              {t(
                analysis().schema
                  ? "channels.config.channelSchemaUnavailable"
                  : "channels.config.schemaUnavailable",
              )}
            </div>
          }
        >
          {(schema) => (
            <>
              <div class="config-form">
                <ConfigTierGroups
                  schema={schema()}
                  path={["channels", params.channelId]}
                  hints={params.props.config.configUiHints}
                  revealAdvanced={params.props.showAdvancedSettings}
                  onShowAdvanced={() => params.props.onShowAdvancedSettings(true)}
                  onHideAdvanced={() => params.props.onShowAdvancedSettings(false)}
                  renderTier={(tier) => (
                    <ConfigNode
                      params={{
                        schema: tier(),
                        value: value(),
                        path: ["channels", params.channelId],
                        hints: params.props.config.configUiHints,
                        unsupported: unsupported(),
                        disabled: disabled(),
                        showLabel: false,
                        maskSensitive: true,
                        replaceStoredSecrets: {
                          source: (path) =>
                            storedSecretSource(params.props.config.configSnapshot, path),
                        },
                        onPatch: (path, next) =>
                          params.props.onConfigPatch(params.channelId, path, next),
                      }}
                    />
                  )}
                />
              </div>
              <Show when={extraFields().length > 0}>
                <div>
                  <For each={extraFields()}>
                    {(field) => (
                      <div class="settings-row__desc">
                        {field}: {formatChannelExtraValue(value()[field])}
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </form>
    </Show>
  );
}
