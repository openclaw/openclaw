import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
// Curated Talk home: realtime provider/model/voice pickers driven by
// talk.catalog, above the embedded talk schema editor (see memory.ts for the
// same curated-rows-above-schema shape). The pickers and the raw form patch the
// same config draft, so both stay in sync without narrowing the schema.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import type {
  NativeDeviceSettingsSnapshot,
  NativeDeviceSettingsCapability,
} from "../../app/native-device-settings.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import type { PickerParams, PickerOption } from "../../components/select-picker.ts";
import "../../components/select-picker.ts";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "./settings-select-row.tsx";
import { DeviceTalk, VoiceWakeEditor, type VoiceWakeEditorState } from "./talk-device.tsx";
import { isTalkGptLiveModel, type TalkRealtimeSelection } from "./talk-schema.ts";

registerEnglishCatalog(registerSettingsEnglish);

export type TalkRealtimeProviderOption = TalkCatalogResult["realtime"]["providers"][number];

/**
 * Catalog as the page knows it. `loading`/`unavailable` keep an unread catalog
 * from rendering as a decided "not configured"; only `ready` makes claims.
 */
export type TalkCatalogState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      ready: boolean;
      activeProvider: string | null;
      providers: readonly TalkRealtimeProviderOption[];
    };

type TalkViewProps = {
  nativeDeviceSettings?: NativeDeviceSettingsCapability | null;
  nativeDeviceSnapshot?: NativeDeviceSettingsSnapshot | null;
  voiceWake?: { state: VoiceWakeEditorState; onInput: (text: string) => void; onRetry: () => void };
  selection: TalkRealtimeSelection;
  catalog: TalkCatalogState;
  modelDefaultPending?: boolean;
  configBusy: boolean;
  onProviderChange: (providerId: string | null) => void;
  onModelChange: (model: string | null) => void;
  onVoiceChange: (voice: string | null) => void;
  /** Embedded schema editor for the full `talk` section. */
  editor: JSX.Element;
};

const TALK_PICKER_UNSET = "";

/** Config may name a provider by alias; pickers always speak canonical ids. */
function findProviderOption(
  providers: readonly TalkRealtimeProviderOption[],
  providerId: string | null,
): TalkRealtimeProviderOption | undefined {
  if (!providerId) {
    return undefined;
  }
  return providers.find(
    (provider) => provider.id === providerId || provider.aliases?.includes(providerId),
  );
}

/**
 * The provider whose models/voices the pickers offer: the explicitly
 * configured one, else the catalog's credential-based auto-selection. An
 * explicit provider the catalog cannot resolve returns no option — falling
 * back to the active provider would offer another provider's models and let a
 * "Provider default" reset clear that unrelated provider's entry.
 */
export function selectedTalkProviderOption(
  catalog: TalkCatalogState,
  selection: TalkRealtimeSelection,
): TalkRealtimeProviderOption | undefined {
  if (catalog.kind !== "ready") {
    return undefined;
  }
  return findProviderOption(catalog.providers, selection.provider || catalog.activeProvider);
}

/**
 * Raw config keys under talk.realtime.providers that belong to the selected
 * provider: the configured spelling plus the canonical id and its aliases.
 * Used both to read effective fallback values and to clear them on reset.
 */
export function talkProviderConfigKeys(
  selection: TalkRealtimeSelection,
  option: TalkRealtimeProviderOption | undefined,
): string[] {
  return uniqueStrings(
    [selection.provider, option?.id, ...(option?.aliases ?? [])].flatMap((key) =>
      key && key in selection.providerEntries ? [key] : [],
    ),
  );
}

/** Effective model/voice: top-level override, else the provider entry value. */
export function effectiveTalkValues(
  selection: TalkRealtimeSelection,
  option: TalkRealtimeProviderOption | undefined,
): { model: string | null; speakerVoice: string | null } {
  let model = selection.model;
  let speakerVoice = selection.speakerVoice;
  for (const key of talkProviderConfigKeys(selection, option)) {
    const entry = selection.providerEntries[key];
    model ??= entry?.model ?? null;
    speakerVoice ??= entry?.speakerVoice ?? null;
  }
  return { model, speakerVoice };
}

function StatusRow(props: TalkViewProps) {
  const status = createMemo(() => {
    const catalog = props.catalog;
    if (catalog.kind !== "ready") {
      return {
        description:
          catalog.kind === "unavailable" ? t("talkPage.status.unavailableHint") : undefined,
        kind: "muted" as const,
        label: t(catalog.kind === "loading" ? "common.loading" : "talkPage.status.unavailable"),
      };
    }
    return {
      description: catalog.activeProvider
        ? t("talkPage.status.activeProvider", { provider: catalog.activeProvider })
        : t("talkPage.status.noProvider"),
      kind: catalog.ready ? ("ok" as const) : ("warn" as const),
      label: t(catalog.ready ? "talkPage.status.ready" : "talkPage.status.notReady"),
    };
  });
  return (
    <SettingsRow
      title={t("talkPage.status.title")}
      description={status().description}
      control={<SettingsStatus kind={status().kind} label={status().label} />}
    />
  );
}

function ConfiguredTalkValue(props: { field: "provider" | "model" | "voice"; value: string }) {
  return (
    <SettingsRow
      title={t(`talkPage.${props.field}.title`)}
      description={t(`talkPage.${props.field}.description`)}
      control={<SettingsValue mono value={props.value} />}
    />
  );
}

function ProviderRow(props: TalkViewProps) {
  const providers = () => (props.catalog.kind === "ready" ? props.catalog.providers : []);
  const selected = () => findProviderOption(providers(), props.selection.provider);
  // A disabled plugin's configured id must stay visible rather than becoming Auto.
  const unknownConfigured = () =>
    props.selection.provider && !selected() ? props.selection.provider : null;
  const options = createMemo(() => [
    ...providers().map((provider) => ({ value: provider.id, label: provider.label })),
    ...(unknownConfigured() ? [{ value: unknownConfigured()!, label: unknownConfigured()! }] : []),
    { value: TALK_PICKER_UNSET, label: t("talkPage.provider.auto") },
  ]);
  return (
    <>
      {providers().length === 0 ? (
        <ConfiguredTalkValue
          field="provider"
          value={props.selection.provider ?? t("talkPage.provider.auto")}
        />
      ) : (
        <SettingsRow
          title={t("talkPage.provider.title")}
          description={t("talkPage.provider.description")}
          stacked
          control={
            <SettingsSegmented
              value={selected()?.id ?? unknownConfigured() ?? TALK_PICKER_UNSET}
              options={options()}
              disabled={props.configBusy}
              ariaLabel={t("talkPage.provider.title")}
              onChange={(value) => props.onProviderChange(value || null)}
            />
          }
        />
      )}
    </>
  );
}

type TalkModelOption = PickerOption & { provider: string };

function ModelRow(props: TalkViewProps) {
  const provider = () => selectedTalkProviderOption(props.catalog, props.selection);
  const model = () => effectiveTalkValues(props.selection, provider()).model;
  const options = createMemo(() => {
    const selected = provider();
    if (!selected) {
      return [];
    }
    const known = selected.models?.length
      ? selected.models
      : selected.defaultModel
        ? [selected.defaultModel]
        : [];
    const values = [
      {
        value: TALK_PICKER_UNSET,
        label: selected.defaultModel
          ? t("talkPage.model.defaultNamed", { model: selected.defaultModel })
          : t("talkPage.model.default"),
      },
      ...known.map((value) => ({ value, label: value })),
      ...(model() && !known.includes(model()!) ? [{ value: model()!, label: model()! }] : []),
    ].map((option) => Object.assign({}, option, { provider: selected.id }));
    const index = values.findIndex((option) => option.value === model());
    if (index > 0) {
      values.unshift(...values.splice(index, 1));
    }
    return values;
  });
  return (
    <>
      {provider() ? (
        <SettingsRow
          title={t("talkPage.model.title")}
          description={t("talkPage.model.description")}
          control={
            <div class="model-picker">
              <openclaw-select-picker
                class="settings-select picker-select model-picker__select"
                style={{ width: "100%", "min-width": "min(138px,100%)" }}
                prop:params={
                  {
                    label: t("talkPage.model.title"),
                    value: model() ?? TALK_PICKER_UNSET,
                    options: options(),
                    disabled: props.configBusy,
                    searchable: true,
                    showOptionTooltips: false,
                    renderLeading: (option) =>
                      renderProviderBrandIcon(option.provider, {
                        className: "model-picker__provider-icon",
                      }),
                    onChange: (value) => props.onModelChange(value || null),
                  } satisfies PickerParams<TalkModelOption>
                }
              />
            </div>
          }
        />
      ) : (
        <ConfiguredTalkValue field="model" value={model() ?? t("talkPage.model.default")} />
      )}
    </>
  );
}

function VoiceRow(props: TalkViewProps) {
  const state = createMemo(() => {
    const provider = selectedTalkProviderOption(props.catalog, props.selection);
    const { model, speakerVoice: voice } = effectiveTalkValues(props.selection, provider);
    // Explicit reset uses public defaults until the config revision acknowledges it.
    const publicModel = props.modelDefaultPending ? provider?.defaultModel : model;
    const publicVoices = provider?.voicesByModel?.[publicModel ?? ""];
    const usesActiveRoute =
      props.modelDefaultPending !== true &&
      (model === null || (isTalkGptLiveModel(model) && publicVoices === undefined));
    const voices = usesActiveRoute
      ? (provider?.activeVoices ?? provider?.voices ?? [])
      : (publicVoices ?? provider?.voices ?? []);
    const unsupported =
      usesActiveRoute &&
      provider?.activeVoiceSelectionPolicy === "allowlist-default" &&
      voice !== null &&
      !voices.includes(voice);
    return {
      voice,
      voices,
      unsupported,
      options: [
        { value: TALK_PICKER_UNSET, label: t("talkPage.voice.default") },
        ...voices.map((value) => ({ value, label: value })),
        ...(voice && !voices.includes(voice)
          ? [
              {
                value: voice,
                label: unsupported ? `${voice} (${t("talkPage.voice.unsupported")})` : voice,
              },
            ]
          : []),
      ],
    };
  });
  return (
    <>
      {state().voices.length === 0 ? (
        <ConfiguredTalkValue field="voice" value={state().voice ?? t("talkPage.voice.default")} />
      ) : (
        <SettingsSelectRow
          title={t("talkPage.voice.title")}
          description={
            state().unsupported
              ? t("talkPage.voice.unsupportedDefault")
              : t("talkPage.voice.description")
          }
          value={state().voice ?? TALK_PICKER_UNSET}
          options={state().options}
          disabled={props.configBusy}
          onChange={(value) => props.onVoiceChange(value || null)}
        />
      )}
    </>
  );
}

function GptLiveRow(props: TalkViewProps) {
  const provider = () => selectedTalkProviderOption(props.catalog, props.selection);
  const model = () => effectiveTalkValues(props.selection, provider()).model;
  return (
    <>
      {provider()?.id === "openai" && isTalkGptLiveModel(model()) && (
        <SettingsRow
          title={t("talkPage.gptLive.title")}
          description={t("talkPage.gptLive.hint")}
          control={
            <SettingsStatus
              kind={provider()?.configured ? "ok" : "warn"}
              label={t(
                provider()?.configured ? "talkPage.gptLive.ready" : "talkPage.status.notReady",
              )}
            />
          }
        />
      )}
    </>
  );
}

export function Talk(props: TalkViewProps) {
  return (
    <section class="talk-page">
      <SettingsPage>
        <DeviceTalk capability={props.nativeDeviceSettings} snapshot={props.nativeDeviceSnapshot} />
        {props.voiceWake && (
          <VoiceWakeEditor
            state={props.voiceWake.state}
            onInput={props.voiceWake.onInput}
            onRetry={props.voiceWake.onRetry}
          />
        )}
        <SettingsSection
          title={t("talkPage.voiceSection.title")}
          description={t("talkPage.voiceSection.description")}
        >
          <StatusRow {...props} />
          <ProviderRow {...props} />
          <ModelRow {...props} />
          <VoiceRow {...props} />
          <GptLiveRow {...props} />
        </SettingsSection>
      </SettingsPage>
      {props.editor}
    </section>
  );
}
