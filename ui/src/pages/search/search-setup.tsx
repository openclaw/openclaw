import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { For, Show, createMemo } from "solid-js";
import type { WebSearchStatusResult } from "../../../../packages/gateway-protocol/src/index.js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { resolveConfigFieldMeta } from "../../components/config-form.search.ts";
import { analyzeConfigSchema, renderNode } from "../../components/config-form.ts";
import { LearnMoreLink, SettingsRow, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import {
  currentConfigObject,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { PluginCredentialEditor } from "../plugins/credential-editor.tsx";
import { pluginConfigSchema } from "../plugins/settings-model.ts";
import { readConfigValue } from "./search-config.ts";

type SearchProvider = WebSearchStatusResult["providers"][number];
type SearchSettingsProps = {
  state: () => Readonly<RuntimeConfigState>;
  canEdit: () => boolean;
  busy: () => boolean;
  commit: (path: Array<string | number>, value: unknown) => Promise<boolean>;
};
type SearchConfigFieldProps = Pick<SearchSettingsProps, "state" | "canEdit" | "busy">;
function SearchConfigField(
  props: SearchConfigFieldProps & {
    schema: JsonSchema;
    path: Array<string | number>;
    value: unknown;
    unsupported: Set<string>;
    patch: (path: Array<string | number>, value: unknown) => Promise<boolean>;
  },
) {
  const hints = () => props.state().configUiHints;
  const meta = () => resolveConfigFieldMeta(props.path, props.schema, hints());
  return (
    <SettingsRow
      title={meta().label}
      description={meta().help}
      stackedOnNarrow
      control={
        <LitContent
          render={() =>
            renderNode({
              schema: props.schema,
              value: props.value,
              path: props.path,
              hints: hints(),
              unsupported: props.unsupported,
              disabled: !props.canEdit() || props.busy(),
              compact: true,
              commitOnBlur: true,
              showLabel: false,
              rawAvailable: false,
              maskSensitive: true,
              onPatch: (path, value) => void props.patch(path, value),
              onRemove: (path) => void props.patch(path, undefined),
            })
          }
        />
      }
    />
  );
}

export function SearchSetup(
  props: SearchSettingsProps & {
    context: ApplicationContext;
    gateway: Pick<GatewayPageController, "capture" | "isCurrent" | "epoch" | "connected">;
    provider: SearchProvider;
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
  const fields = () =>
    Object.entries(schema()?.properties ?? {}).filter(([key]) => {
      const descriptor = credential();
      return (
        !descriptor ||
        descriptor.path.length !== props.provider.configPath.length + 1 ||
        !props.provider.configPath.every((segment, index) => segment === descriptor.path[index]) ||
        descriptor.path.at(-1) !== key
      );
    });
  return (
    <>
      <SettingsRow
        title={t("searchPage.configuration")}
        description={t(`searchPage.credentialSources.${props.provider.credentialSource}`)}
        control={
          <SettingsStatus
            kind={props.provider.available && props.provider.configured ? "ok" : "warn"}
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
        }
      />
      <Show when={credential()}>
        {(descriptor) => (
          <SettingsRow
            title={descriptor().label}
            stackedOnNarrow
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
                  saveError: props.state().lastError,
                  onCommit: props.commit,
                  onDiscard: () => props.context.runtimeConfig.discardFormValue(descriptor().path),
                }}
              />
            }
          />
        )}
      </Show>
      <For each={fields()} keyed={(field) => field[0]}>
        {(field) => (
          <SearchConfigField
            schema={field()[1]}
            path={[...props.provider.configPath, field()[0]]}
            value={values()?.[field()[0]]}
            unsupported={unsupported()}
            patch={props.commit}
            state={props.state}
            canEdit={props.canEdit}
            busy={props.busy}
          />
        )}
      </For>
      <SettingsRow
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
          <SettingsRow title={t("searchPage.docs")} control={<LearnMoreLink url={url()} />} />
        )}
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
  const fields = () =>
    Object.entries(schema()?.properties ?? {}).filter(
      ([key]) => key !== "enabled" && key !== "provider",
    );
  return (
    <Show when={fields().length > 0}>
      <details class="settings-section config-advanced-disclosure">
        <summary class="settings-section__heading config-advanced-disclosure__summary">
          {t("searchPage.advanced")}
        </summary>
        <div class="settings-group">
          <For each={fields()} keyed={(field) => field[0]}>
            {(field) => (
              <SearchConfigField
                schema={field()[1]}
                path={["tools", "web", "search", field()[0]]}
                value={value()?.[field()[0]]}
                unsupported={unsupported()}
                patch={props.commit}
                state={props.state}
                canEdit={props.canEdit}
                busy={props.busy}
              />
            )}
          </For>
        </div>
      </details>
    </Show>
  );
}
