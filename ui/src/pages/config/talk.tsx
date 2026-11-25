import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
// Curated Talk page: the active mode's cards first, the other mode collapsed, then an Advanced
// schema editor for the keys no curated control owns (talkSettingsSchema). Provider lists and
// readiness come from talk.catalog; every control patches the same config draft.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, Loading, Show } from "solid-js";
import type {
  NativeDeviceSettingsSnapshot,
  NativeDeviceSettingsCapability,
} from "../../app/native-device-settings.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { Checkbox } from "../../components/solid/checkbox.tsx";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { projectTheme } from "../../lib/reactive/theme.ts";
import { SettingsPickerRow, SettingsSelectRow } from "./settings-select-row.tsx";
import { DeviceTalk, VoiceWakeEditor, type VoiceWakeEditorState } from "./talk-device.tsx";
import { resolveTalkModelFamilySettings, type TalkRealtimeSelection } from "./talk-schema.ts";
import { talkProviderStatus, talkProviderStatusLabel } from "./talk-status.ts";

registerEnglishCatalog(registerSettingsEnglish);

export type TalkRealtimeProviderOption = TalkCatalogResult["realtime"]["providers"][number];

/**
 * Catalog as the page knows it. `loading`/`unavailable` keep an unread catalog
 * from rendering as a decided "not configured"; only `ready` makes claims.
 */
/** Which speech-to-text rows a mount shows: Talk's own, the voice notes model, or both. */
export type TalkTranscriptionParts = { talk: boolean; voiceNotes: boolean };

export type TalkCatalogState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "failed"; error: unknown }
  | {
      kind: "ready";
      ready: boolean;
      activeProvider: string | null;
      providers: readonly TalkRealtimeProviderOption[];
      /** Speech-to-text group of the same catalog read. */
      transcription?: TalkCatalogResult["transcription"];
      speech?: TalkCatalogResult["speech"];
    };

type TalkViewProps = {
  presentationRetired: () => Promise<void>;
  nativeDeviceSettings?: NativeDeviceSettingsCapability | null;
  nativeDeviceSnapshot?: NativeDeviceSettingsSnapshot | null;
  voiceWake?: {
    readState: () => VoiceWakeEditorState;
    scope?: object | null;
    saving: boolean;
    readWriteResult: () => void;
    onInput: (text: string) => void;
    onRetry: () => void;
  };
  selection: TalkRealtimeSelection;
  catalog: TalkCatalogState;
  catalogScope?: object | null;
  modelDefaultPending?: boolean;
  configBusy: boolean;
  agentSettings?: JSX.Element;
  splitVoice?: (catalog: () => TalkCatalogState) => JSX.Element;
  liveTuning?: JSX.Element;
  onModeChange?: (mode: "realtime" | "stt-tts" | "transcription") => void;
  onProviderChange: (providerId: string | null) => void;
  onModelChange: (model: string | null) => void;
  onVoiceChange: (voice: string | null) => void;
  /**
   * Speech-to-text section, rendered from the same catalog read. The accessor
   * keeps one mounted section across catalog re-reads.
   */
  transcription?: (catalog: () => TalkCatalogState, parts: TalkTranscriptionParts) => JSX.Element;
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

type ReadinessGroup = {
  ready?: boolean;
  activeProvider?: string;
  providers: readonly { id: string; label?: string; configured?: boolean }[];
};

/** One readiness line for a stage: the provider Talk will use and whether it can run. */
function ReadinessRow(props: {
  title: string;
  /** The stage can fall back to a general route when no provider is chosen (speech only). */
  generalRoute?: boolean;
  catalog: TalkCatalogState;
  group: (catalog: Extract<TalkCatalogState, { kind: "ready" }>) => ReadinessGroup | undefined;
}) {
  const status = () => {
    const catalog = props.catalog;
    if (catalog.kind !== "ready") {
      return {
        description:
          catalog.kind === "failed"
            ? formatUiError(catalog.error, t("talkPage.status.catalogFailedHint"))
            : catalog.kind === "unavailable"
              ? t("talkPage.status.unavailableHint")
              : undefined,
        kind: "muted" as const,
        label: t(catalog.kind === "loading" ? "common.loading" : "talkPage.status.unavailable"),
      };
    }
    const group = props.group(catalog);
    const active = group?.activeProvider;
    if (!active && group && props.generalRoute) {
      // No Talk speech provider is chosen: browser Talk speaks through the general
      // text-to-speech route, whose readiness the Talk catalog does not report.
      return {
        description: undefined,
        kind: "muted" as const,
        label: t("talkPage.revamp.generalSpeech"),
      };
    }
    const entry = group?.providers.find(({ id }) => id === active);
    const name = active ? (entry?.label ?? providerDisplayLabel(active)) : undefined;
    const state = entry
      ? talkProviderStatus(group, entry)
      : group?.ready
        ? "ready"
        : "notConfigured";
    const ready = state === "ready" || state === "configured";
    return {
      description: undefined,
      kind: ready ? ("ok" as const) : ("warn" as const),
      label: name ? `${name} · ${talkProviderStatusLabel(state)}` : talkProviderStatusLabel(state),
    };
  };
  return (
    <SettingsRow
      title={props.title}
      description={status().description}
      control={<SettingsStatus kind={status().kind} label={status().label} />}
    />
  );
}

/**
 * A free-text row for a value the catalog gives no choices for (an unlisted provider, a model
 * the provider does not enumerate, a provider with no voice inventory), so it stays editable.
 */
function TalkTextRow(props: {
  field: "provider" | "model" | "voice";
  value: string | null;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const value = createMemo(() => props.value ?? "");
  return (
    <SettingsRow
      title={t(`talkPage.${props.field}.title`)}
      description={props.field === "voice" ? t("talkPage.voice.description") : undefined}
      control={
        <input
          aria-label={t(`talkPage.${props.field}.title`)}
          class="settings-input"
          disabled={props.disabled}
          ref={liveValue(value)}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.currentTarget.value.trim() || null)}
        />
      }
    />
  );
}

function ProviderRow(props: TalkViewProps) {
  const providers = () => (props.catalog.kind === "ready" ? props.catalog.providers : []);
  const selected = () => findProviderOption(providers(), props.selection.provider);
  // A disabled plugin's configured id must stay visible rather than becoming Auto.
  const unknownConfigured = () =>
    props.selection.provider && !selected() ? props.selection.provider : null;
  const activeLabel = () =>
    props.catalog.kind === "ready"
      ? findProviderOption(providers(), props.catalog.activeProvider)?.label
      : undefined;
  const autoLabel = () =>
    activeLabel()
      ? t("talkPage.provider.autoNamed", { provider: activeLabel()! })
      : t("talkPage.provider.auto");
  // The Gateway reports the route it will use; an older Gateway omits it, so nothing is guessed.
  const route = () => {
    const option = selectedTalkProviderOption(props.catalog, props.selection);
    // `authRoute` ships with the optional Gateway route field (#204674), so older protocol
    // types do not declare it; only the two known values are shown.
    const authRoute = option && "authRoute" in option ? option.authRoute : undefined;
    if (authRoute !== "api-key" && authRoute !== "chatgpt-sign-in") {
      return undefined;
    }
    const model = effectiveTalkValues(props.selection, option).model ?? option?.defaultModel;
    const label = t(
      authRoute === "api-key" ? "talkPage.provider.routeApiKey" : "talkPage.provider.routeSignIn",
    );
    return model ? `${label} · ${model}` : label;
  };
  const options = createMemo(() => [
    { value: TALK_PICKER_UNSET, label: autoLabel() },
    ...providers().map((provider) => ({
      value: provider.id,
      label: provider.label,
      description: talkProviderStatusLabel(
        talkProviderStatus(
          props.catalog.kind === "ready"
            ? { ready: props.catalog.ready, activeProvider: props.catalog.activeProvider }
            : undefined,
          provider,
        ),
      ),
    })),
    ...(unknownConfigured() ? [{ value: unknownConfigured()!, label: unknownConfigured()! }] : []),
  ]);
  return (
    <>
      {providers().length === 0 ? (
        <TalkTextRow
          field="provider"
          value={props.selection.provider}
          placeholder={t("talkPage.provider.auto")}
          disabled={props.configBusy}
          onChange={props.onProviderChange}
        />
      ) : (
        <SettingsPickerRow
          title={t("talkPage.provider.title")}
          description={route()}
          value={selected()?.id ?? unknownConfigured() ?? TALK_PICKER_UNSET}
          options={options()}
          disabled={props.configBusy}
          onChange={(value) => props.onProviderChange(value || null)}
        />
      )}
    </>
  );
}

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
    return values;
  });
  return (
    <>
      {provider() ? (
        <SettingsRow
          title={t("talkPage.model.title")}
          control={
            <ModelPicker
              label={t("talkPage.model.title")}
              value={model() ?? TALK_PICKER_UNSET}
              options={options()}
              disabled={props.configBusy}
              custom={{
                label: t("talkPage.model.custom"),
                placeholder: provider()?.defaultModel ?? "",
                commit: "change",
              }}
              onChange={(value) => props.onModelChange(value || null)}
            />
          }
        />
      ) : (
        <TalkTextRow
          field="model"
          value={model()}
          placeholder={t("talkPage.model.default")}
          disabled={props.configBusy}
          onChange={props.onModelChange}
        />
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
    const family = resolveTalkModelFamilySettings(provider, model);
    const usesActiveRoute =
      props.modelDefaultPending !== true &&
      (model === null || (family?.unlistedModelVoices === "active" && publicVoices === undefined));
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
        <TalkTextRow
          field="voice"
          value={state().voice}
          placeholder={t("talkPage.voice.default")}
          disabled={props.configBusy}
          onChange={props.onVoiceChange}
        />
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

function ModelFamilyRow(props: TalkViewProps) {
  const provider = () => selectedTalkProviderOption(props.catalog, props.selection);
  const settings = () =>
    resolveTalkModelFamilySettings(
      provider(),
      effectiveTalkValues(props.selection, provider()).model,
    );
  return (
    <Show when={settings()}>
      {(family) => (
        <SettingsRow
          title={t(family().hint.titleKey)}
          description={t(family().hint.descriptionKey)}
          control={
            <SettingsStatus
              kind={provider()?.configured ? "ok" : "warn"}
              label={t(
                provider()?.configured ? family().hint.readyKey : "talkPage.status.notReady",
              )}
            />
          }
        />
      )}
    </Show>
  );
}

function TalkCatalogRows(props: TalkViewProps) {
  return (
    <>
      <ProviderRow {...props} />
      <ModelRow {...props} />
      <VoiceRow {...props} />
      <ModelFamilyRow {...props} />
    </>
  );
}

export function Talk(props: TalkViewProps) {
  const chimeLabelStyle = { display: "flex", "align-items": "center", gap: "var(--space-2)" };
  const chimeCheckboxStyle = {
    "--check-fill": "color-mix(in srgb, var(--text) 55%, var(--border))",
    "--check-mark": "var(--field-bg)",
  };
  // The application theme owner republishes storage changes, so a second tab stays in sync.
  const application = useOptionalApplication();
  const theme = application?.theme ? projectTheme(application.theme) : undefined;
  const [standalone, setChimes] = createSignal(loadSettings());
  const chimes = () => (theme ? theme.preferences.read() : standalone());
  const splitMode = createMemo(() => props.selection.mode === "stt-tts");
  // Transcription-only has no assistant voice: it shows the speech-to-text cards alone.
  const transcriptionOnly = createMemo(() => props.selection.mode === "transcription");
  const sttLayout = createMemo(() => splitMode() || transcriptionOnly());
  const updateChime = (
    key: "talkChimeStart" | "talkChimeEnd" | "talkChimeReply",
    enabled: boolean,
  ) => {
    const patch = { [key]: enabled };
    patchSettings(patch);
    setChimes((current) => ({ ...current, ...patch }));
  };
  // The catalog read can suspend, so each render of the rows sits inside the page's boundaries.
  const readinessRows = () => (
    <Errored fallback={(error) => readinessFor({ kind: "failed", error: error() })}>
      <Loading on={props.catalogScope} fallback={readinessFor({ kind: "loading" })}>
        {readinessFor(props.catalog)}
      </Loading>
    </Errored>
  );
  const readinessFor = (catalog: TalkCatalogState) =>
    sttLayout() ? (
      <>
        <ReadinessRow
          title={t("talkPage.transcription.title")}
          catalog={catalog}
          group={(ready) => ready.transcription}
        />
        <Show when={!transcriptionOnly()}>
          <ReadinessRow
            title={t("talkPage.revamp.voice")}
            catalog={catalog}
            generalRoute
            group={(ready) => ready.speech}
          />
        </Show>
      </>
    ) : (
      <ReadinessRow
        title={t("talkPage.revamp.hearingVoice")}
        catalog={catalog}
        group={(ready) => ({
          ready: ready.ready,
          activeProvider: ready.activeProvider ?? undefined,
          providers: ready.providers,
        })}
      />
    );
  const liveVoiceSettings = () => (
    <SettingsSection title={t("talkPage.voiceSection.title")}>
      <Errored
        fallback={(error) => (
          <TalkCatalogRows {...props} catalog={{ kind: "failed", error: error() }} />
        )}
      >
        <Loading
          on={props.catalogScope}
          fallback={<TalkCatalogRows {...props} catalog={{ kind: "loading" }} />}
        >
          <TalkCatalogRows {...props} />
        </Loading>
      </Errored>
      {props.liveTuning}
    </SettingsSection>
  );
  const transcriptionSection = (parts: TalkTranscriptionParts) =>
    props.transcription && (
      <Errored
        fallback={(error) =>
          props.transcription!(() => ({ kind: "failed", error: error() }), parts)
        }
      >
        <Loading
          on={props.catalogScope}
          fallback={props.transcription(() => ({ kind: "loading" }), parts)}
        >
          {props.transcription(() => props.catalog, parts)}
        </Loading>
      </Errored>
    );
  const voiceSection = () =>
    props.splitVoice &&
    !transcriptionOnly() && (
      <Errored fallback={() => props.splitVoice!(() => ({ kind: "unavailable" }))}>
        <Loading on={props.catalogScope} fallback={props.splitVoice(() => ({ kind: "loading" }))}>
          {props.splitVoice(() => props.catalog)}
        </Loading>
      </Errored>
    );
  // Voice notes work in both modes, so Live keeps that row on the page.
  const liveSettings = () => (
    <>
      {liveVoiceSettings()}
      {transcriptionSection({ talk: false, voiceNotes: true })}
    </>
  );
  const splitSettings = (voiceNotes: boolean) => (
    <>
      {transcriptionSection({ talk: true, voiceNotes })}
      {voiceSection()}
    </>
  );
  return (
    <section class="talk-page">
      <SettingsPage>
        <SettingsSection title={t("talkPage.revamp.modeSection")}>
          <SettingsSelectRow
            title={t("talkPage.revamp.mode")}
            value={props.selection.mode ?? "realtime"}
            options={[
              { value: "realtime", label: t("talkPage.revamp.live") },
              { value: "stt-tts", label: t("talkPage.revamp.split") },
              { value: "transcription", label: t("talkPage.revamp.transcription") },
            ]}
            disabled={props.configBusy || !props.onModeChange}
            onChange={(mode) => {
              if (mode === "realtime" || mode === "stt-tts" || mode === "transcription") {
                props.onModeChange?.(mode);
              }
            }}
          />
          {readinessRows()}
        </SettingsSection>
        {props.agentSettings}
        <SettingsSection title={t("talkPage.chimesSection.title")}>
          <div class="settings-row">
            <div
              style={{ display: "flex", "flex-wrap": "wrap", gap: "var(--space-4)" }}
              role="group"
              aria-label={t("talkPage.chimesSection.title")}
            >
              <label class="settings-row__desc" style={chimeLabelStyle}>
                <Checkbox
                  style={chimeCheckboxStyle}
                  checked={chimes().talkChimeStart !== false}
                  onChange={(event) => updateChime("talkChimeStart", event.currentTarget.checked)}
                />
                {t("talkPage.chimeStart")}
              </label>
              <label class="settings-row__desc" style={chimeLabelStyle}>
                <Checkbox
                  style={chimeCheckboxStyle}
                  checked={chimes().talkChimeEnd !== false}
                  onChange={(event) => updateChime("talkChimeEnd", event.currentTarget.checked)}
                />
                {t("talkPage.chimeEnd")}
              </label>
              <Show when={splitMode()}>
                <label class="settings-row__desc" style={chimeLabelStyle}>
                  <Checkbox
                    style={chimeCheckboxStyle}
                    checked={chimes().talkChimeReply !== false}
                    onChange={(event) => updateChime("talkChimeReply", event.currentTarget.checked)}
                  />
                  {t("talkPage.chimeReply")}
                </label>
              </Show>
            </div>
          </div>
        </SettingsSection>
        <DeviceTalk
          capability={props.nativeDeviceSettings}
          snapshot={props.nativeDeviceSnapshot}
          presentationRetired={props.presentationRetired}
        />
        {props.voiceWake && (
          <VoiceWakeEditor
            readState={props.voiceWake.readState}
            scope={props.voiceWake.scope}
            saving={props.voiceWake.saving}
            readWriteResult={props.voiceWake.readWriteResult}
            onInput={props.voiceWake.onInput}
            onRetry={props.voiceWake.onRetry}
          />
        )}
        <Show when={sttLayout()} fallback={liveSettings()}>
          {splitSettings(true)}
        </Show>
        <SettingsDisclosure
          sections
          title={t(sttLayout() ? "talkPage.voiceSection.title" : "talkPage.revamp.split")}
        >
          <Show when={sttLayout()} fallback={splitSettings(false)}>
            {liveVoiceSettings()}
          </Show>
        </SettingsDisclosure>
      </SettingsPage>
      <SettingsDisclosure sections title={t("talkPage.revamp.advanced")}>
        {props.editor}
      </SettingsDisclosure>
    </section>
  );
}
