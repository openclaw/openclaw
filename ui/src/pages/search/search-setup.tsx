import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Show, createMemo } from "solid-js";
import type { WebSearchStatusResult } from "../../../../packages/gateway-protocol/src/index.js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { analyzeConfigSchema } from "../../components/config-form.analyze.ts";
import {
  flattenConfigLeafFields,
  type ConfigLeafField,
} from "../../components/config-form.leaf-fields.ts";
import { resolveConfigObjectFields } from "../../components/config-form.node.collection.ts";
import { ConfigNode } from "../../components/config-form.node.tsx";
import { hintForPath, pathKey } from "../../components/config-form.shared.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { LearnMoreLink, SettingsRow, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import type { ConfigSecretFields } from "../../lib/config/config-secret-fields.ts";
import {
  currentConfigObject,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PluginCredentialEditor } from "../plugins/credential-editor.tsx";
import { pluginConfigSchema } from "../plugins/settings-model.ts";
import { isProviderReady, readConfigValue } from "./search-config.ts";

type SearchProvider = WebSearchStatusResult["providers"][number];
type SearchSettingsProps = {
  state: () => Readonly<RuntimeConfigState>;
  canEdit: () => boolean;
  busy: () => boolean;
  commit: (path: Array<string | number>, value: unknown) => Promise<boolean>;
  secretFields: ConfigSecretFields;
};

/** Leaf rows for one config object; nested objects become labeled rows, never a row control. */
function searchConfigFields(
  props: Pick<SearchSettingsProps, "state" | "canEdit" | "busy" | "secretFields">,
  object: {
    schema: JsonSchema | null | undefined;
    path: Array<string | number>;
    value: unknown;
    unsupported: Set<string>;
    patch: (path: Array<string | number>, value: unknown) => Promise<boolean>;
  },
): ConfigLeafField[] {
  if (!object.schema) {
    return [];
  }
  return resolveConfigObjectFields({
    schema: object.schema,
    value: object.value,
    path: object.path,
    hints: props.state().configUiHints,
    unsupported: object.unsupported,
    disabled: !props.canEdit() || props.busy(),
    compact: true,
    commitOnBlur: true,
    rawAvailable: false,
    maskSensitive: true,
    secretFields: props.secretFields,
    onPatch: (path, value) => void object.patch(path, value),
    onRemove: (path) => void object.patch(path, undefined),
  }).fields.flatMap((field) => flattenConfigLeafFields(field, String(field.path.at(-1))));
}

function SearchConfigField(props: { field: ConfigLeafField; nested?: boolean }) {
  return (
    <SettingsRow
      title={props.field.label}
      description={props.field.help}
      stackedOnNarrow
      nested={props.nested}
      control={
        <ConfigNode
          params={{
            ...props.field,
            showLabel: false,
            // The control's accessible name carries the full nested label, like its row title.
            hints: {
              ...props.field.hints,
              [pathKey(props.field.path)]: {
                ...hintForPath(props.field.path, props.field.hints),
                label: props.field.label,
              },
            },
          }}
        />
      }
    />
  );
}

export function SearchSetup(
  props: SearchSettingsProps & {
    context: ApplicationContext;
    gateway: Pick<GatewayPageBinding, "capture" | "isCurrent" | "epoch" | "connected" | "client">;
    provider: SearchProvider;
    getPresentationLifetime: () => Promise<void>;
  },
) {
  const config = () => currentConfigObject(props.state());
  const analysis = createMemo(() => analyzeConfigSchema(props.state().configSchema));
  const unsupported = createMemo(() => new Set(analysis().unsupportedPaths));
  const schema = () =>
    props.provider.configPath.length
      ? props.provider.configPath
          .slice(4)
          .reduce<JsonSchema | null>(
            (node, key) => node?.properties?.[key] ?? null,
            pluginConfigSchema(analysis().schema, props.provider.pluginId),
          )
      : null;
  const values = () => asNullableRecord(readConfigValue(config(), props.provider.configPath));
  const credential = () => props.provider.credential;
  const credentialKey = () => {
    const path = credential()?.path;
    return path ? JSON.stringify(path) : undefined;
  };
  const fields = createMemo(() =>
    searchConfigFields(props, {
      schema: schema(),
      path: props.provider.configPath,
      value: values(),
      unsupported: unsupported(),
      patch: props.commit,
    }).filter((field) => JSON.stringify(field.path) !== credentialKey()),
  );
  return (
    <>
      {/* The list row carries the status; a missing key shows as its empty field. */}
      <Show when={props.provider.credentialSource !== "missing" || !credential()}>
        <SettingsRow
          title={t("searchPage.configuration")}
          description={t(`searchPage.credentialSources.${props.provider.credentialSource}`)}
          nested
        />
      </Show>
      <Show when={credential()}>
        {(descriptor) => (
          <SettingsRow
            title={descriptor().label}
            stackedOnNarrow
            nested
            control={
              <PluginCredentialEditor
                field={{
                  path: descriptor().path,
                  value: readConfigValue(config(), descriptor().path),
                  disabled: !props.canEdit() || props.busy(),
                }}
                descriptor={descriptor()}
                context={{
                  pluginId: props.provider.pluginId,
                  baseHash: props.state().configSnapshot?.hash ?? null,
                  gateway: props.gateway,
                  canInspect: props.canEdit(),
                  getPresentationLifetime: () => props.getPresentationLifetime(),
                  get saveError() {
                    return props.state().lastError;
                  },
                  onCommit: props.commit,
                  onDiscard: () => props.context.runtimeConfig.discardFormValue(descriptor().path),
                }}
              />
            }
          />
        )}
      </Show>
      <For each={fields()} keyed={(field) => JSON.stringify(field.path)}>
        {(field) => <SearchConfigField field={field()} nested />}
      </For>
      <SettingsRow
        nested
        title={t("searchPage.pluginSettings")}
        description={t("searchPage.pluginSettingsHint")}
        control={
          <a
            class="btn btn--sm"
            href={`${pathForRoute("plugin-settings", props.context.basePath)}/${encodeURIComponent(props.provider.pluginId)}?view=settings`}
          >
            {t("pluginsPage.detailSettings")}
          </a>
        }
      />
      <Show when={props.provider.docsUrl}>
        {(url) => (
          <SettingsRow
            nested
            title={t("searchPage.docs")}
            control={<LearnMoreLink url={url()} />}
          />
        )}
      </Show>
    </>
  );
}

/** One provider in the setup list: its status at a glance, its setup in place when opened. */
export function SearchProviderRow(
  props: Parameters<typeof SearchSetup>[0] & {
    open: boolean;
    /** Only a provider in use warns, so unused providers don't read as a wall of problems. */
    inUse: boolean;
    onToggle: () => void;
  },
) {
  const ready = () => isProviderReady(props.provider);
  return (
    <>
      <button
        type="button"
        class="settings-row settings-row--nav search-provider"
        aria-expanded={props.open ? "true" : "false"}
        onClick={() => props.onToggle()}
      >
        <span class="settings-row__text">
          <span class="settings-row__title">{props.provider.label}</span>
          <Show when={props.open && props.provider.hint}>
            <span class="settings-row__desc">{props.provider.hint}</span>
          </Show>
        </span>
        <span class="settings-row__control">
          <SettingsStatus
            kind={ready() ? "ok" : props.inUse ? "warn" : "muted"}
            label={t(
              !props.provider.installed
                ? "searchPage.pluginMissing"
                : !props.provider.available
                  ? "searchPage.pluginUnavailable"
                  : props.provider.configured
                    ? "searchPage.configured"
                    : "searchPage.needsSetup",
            )}
          />
          <span class="settings-row__chevron">
            <Icon name="chevronRight" />
          </span>
        </span>
      </button>
      <Show when={props.open}>
        <SearchSetup
          provider={props.provider}
          state={props.state}
          context={props.context}
          gateway={props.gateway}
          getPresentationLifetime={props.getPresentationLifetime}
          secretFields={props.secretFields}
          canEdit={props.canEdit}
          busy={props.busy}
          commit={(path, value) =>
            props.open ? props.commit(path, value) : Promise.resolve(false)
          }
        />
      </Show>
    </>
  );
}

export function AdvancedSearchSettings(props: SearchSettingsProps) {
  const analysis = createMemo(() => analyzeConfigSchema(props.state().configSchema));
  const unsupported = createMemo(() => new Set(analysis().unsupportedPaths));
  const schema = () => analysis().schema?.properties?.tools?.properties?.web?.properties?.search;
  const config = () => currentConfigObject(props.state());
  const value = () => asNullableRecord(readConfigValue(config(), ["tools", "web", "search"]));
  const fields = createMemo(() =>
    searchConfigFields(props, {
      schema: schema(),
      path: ["tools", "web", "search"],
      value: value(),
      unsupported: unsupported(),
      patch: props.commit,
    }).filter((field) => field.property !== "enabled" && field.property !== "provider"),
  );
  return (
    <Show when={fields().length > 0}>
      <SettingsDisclosure class="config-advanced-disclosure" title={t("searchPage.advanced")}>
        <For each={fields()} keyed={(field) => JSON.stringify(field.path)}>
          {(field) => <SearchConfigField field={field()} />}
        </For>
      </SettingsDisclosure>
    </Show>
  );
}
