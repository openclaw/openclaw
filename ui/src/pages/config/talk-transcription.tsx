// Speech-to-text rows for the Talk page. The Talk row reports how Talk listens,
// which the Gateway decides (talk.catalog `source`), and links to the setting
// that chose it. The Voice notes row edits the shared media-understanding audio
// config (`tools.media.models` + `tools.media.audio.preferredModel`), the same
// keys the AI Agents → Tools schema editor exposes; Talk also uses that model
// when nothing else chooses Talk's provider. Provider keys stay on
// Settings → Models; a provider that is not ready links there.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { createMemo, createSignal, Show } from "solid-js";
import { pathForPluginSettings } from "../../app-route-paths.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { navigateToModelProvider } from "../model-providers/navigation.ts";

const AUTOMATIC = "";

type TalkTranscriptionCatalog = TalkCatalogResult["transcription"];

type AudioModelEntry = { provider: string; model: string };

/** Audio-tagged `tools.media.models` entries plus the preferred pick, from the config draft. */
function resolveTalkTranscriptionSelection(configObject: Record<string, unknown>) {
  const media = readRecord(readRecord(configObject.tools)?.media);
  const rawModels = Array.isArray(media?.models) ? media.models : [];
  const entries: AudioModelEntry[] = [];
  for (const raw of rawModels) {
    const entry = readRecord(raw);
    const provider = readTrimmedString(entry?.provider);
    const model = readTrimmedString(entry?.model);
    const capabilities = Array.isArray(entry?.capabilities) ? entry.capabilities : [];
    if (provider && model && capabilities.includes("audio")) {
      entries.push({ provider, model });
    }
  }
  return {
    modelCount: rawModels.length,
    entries,
    preferredModel: readTrimmedString(readRecord(media?.audio)?.preferredModel),
    talkAgentId: readTrimmedString(readRecord(configObject.talk)?.agentId),
  };
}

/** `provider/model`, split at the first slash (OpenRouter model ids contain slashes). */
function splitModelRef(ref: string): AudioModelEntry | null {
  const match = /^([^\s/]+)\/(\S+)$/.exec(ref);
  return match ? { provider: match[1]!, model: match[2]! } : null;
}

type TranscriptionProps = {
  configObject: Record<string, unknown>;
  catalog: TalkTranscriptionCatalog | "loading" | "unavailable" | { failed: unknown };
  /** Providers Settings → Models can add a key for; undefined when unknown. */
  modelKeyProviders?: readonly string[];
  configBusy: boolean;
};

/**
 * Picking a model makes it the preferred audio entry; a `provider/model` ref
 * with no matching entry is appended as an audio-tagged entry first, so the
 * runtime can resolve it. Automatic clears only the preference: the entries
 * stay and the runtime tries them in configured order. A ref that is not
 * `provider/model` is rejected without touching the saved preference, since
 * the runtime could never match it. Returns whether the value was accepted.
 */
function changeTranscriptionModel(
  runtimeConfig: ReturnType<typeof useApplication>["runtimeConfig"],
  configObject: Record<string, unknown>,
  value: string,
): boolean {
  const ref = value.trim();
  if (!ref) {
    runtimeConfig.removeFormValue(["tools", "media", "audio", "preferredModel"]);
    return true;
  }
  const parsed = splitModelRef(ref);
  if (!parsed) {
    return false;
  }
  const selection = resolveTalkTranscriptionSelection(
    runtimeConfig.state.configForm ?? configObject,
  );
  if (
    !selection.entries.some(
      (entry) => entry.provider === parsed.provider && entry.model === parsed.model,
    )
  ) {
    runtimeConfig.patchForm(["tools", "media", "models", selection.modelCount], {
      provider: parsed.provider,
      model: parsed.model,
      capabilities: ["audio"],
    });
  }
  runtimeConfig.patchForm(["tools", "media", "audio", "preferredModel"], ref);
  return true;
}

type CatalogState = TranscriptionProps["catalog"];

function loadedCatalog(catalog: CatalogState) {
  return typeof catalog === "object" && !("failed" in catalog) ? catalog : undefined;
}

// Every streaming transcription provider reads its key from the Voice Call
// streaming config; only some also accept a Models key, so Talk's setup and
// change links go there rather than to Models.
type TalkLink = "voice-call" | "voice-model";

/**
 * How Talk listens, in user terms, plus the one place a user changes it.
 * `preferredProviderId` is the provider of the picked voice-notes model.
 */
function talkRowState(
  catalog: CatalogState,
  preferredProviderId: string | undefined,
): { kind: "muted" | "ok" | "warn"; label: string; description: string; link?: TalkLink } {
  if (catalog === "loading" || catalog === "unavailable") {
    return {
      kind: "muted" as const,
      label: t(catalog === "loading" ? "common.loading" : "talkPage.status.unavailable"),
      description:
        catalog === "unavailable" ? t("talkPage.transcription.unavailableHint") : "\u00a0",
      link: undefined,
    };
  }
  if ("failed" in catalog) {
    return {
      kind: "muted" as const,
      label: t("talkPage.status.unavailable"),
      description: formatUiError(catalog.failed, t("talkPage.transcription.failedHint")),
      link: undefined,
    };
  }
  const loaded = catalog;
  const status = {
    kind: loaded.ready ? ("ok" as const) : ("warn" as const),
    label: t(loaded.ready ? "talkPage.status.ready" : "talkPage.status.notReady"),
  };
  const provider = loaded.activeProvider ? providerDisplayLabel(loaded.activeProvider) : null;
  if (loaded.source === "media-understanding") {
    // Another audio model can serve Talk while the picked one is not ready:
    // name the provider in use rather than point at the picked model.
    const fallback =
      provider && preferredProviderId && loaded.activeProvider !== preferredProviderId;
    return {
      ...status,
      description: fallback
        ? t("talkPage.transcription.talkUsesFallback", { provider })
        : t("talkPage.transcription.talkUsesVoiceNotes"),
      link: undefined,
    };
  }
  if (!provider) {
    return loaded.ready
      ? {
          ...status,
          description: t("talkPage.transcription.readyWithoutProvider"),
          link: undefined,
        }
      : {
          ...status,
          description: t("talkPage.transcription.talkNotSetUp"),
          link: "voice-call",
        };
  }
  if (!loaded.source) {
    // Callers without operator.read are not told which setting chose the provider.
    return {
      ...status,
      description: t("talkPage.transcription.talkUses", { provider }),
      link: undefined,
    };
  }
  if (loaded.source === "voice-model") {
    return {
      ...status,
      description: t("talkPage.transcription.talkVoiceModel", { provider }),
      link: "voice-model",
    };
  }
  if (loaded.source === "streaming") {
    return {
      ...status,
      description: t("talkPage.transcription.talkVoiceCall", { provider }),
      link: "voice-call",
    };
  }
  return {
    ...status,
    description: t("talkPage.transcription.talkAutomatic", { provider }),
    link: "voice-call",
  };
}

function TalkRow(props: { catalog: CatalogState; preferredProviderId: string | undefined }) {
  const context = useApplication();
  const state = createMemo(() => talkRowState(props.catalog, props.preferredProviderId));
  const open = (link: TalkLink) => {
    if (link === "voice-call") {
      context.navigate("plugin-settings", {
        pathname: pathForPluginSettings("voice-call", context.basePath),
        search: "",
        hash: "#configuration",
      });
    } else {
      context.navigate("ai-agents", { search: "?section=agents" });
    }
  };
  return (
    <SettingsRow
      title={t("talkPage.transcription.talkTitle")}
      description={state().description}
      control={
        <>
          <SettingsStatus kind={state().kind} label={state().label} />
          <Show when={state().link}>
            {(link) => (
              <button type="button" class="btn" onClick={() => open(link())}>
                {t(
                  state().kind === "warn"
                    ? "talkPage.transcription.setUp"
                    : "talkPage.transcription.change",
                )}
              </button>
            )}
          </Show>
        </>
      }
    />
  );
}

/**
 * The catalog entry for the preferred model's provider, whose `configured`
 * flag is the picked model's readiness. `configured: false` covers a missing
 * credential and a provider with no transcription support alike, so the hint
 * names both causes. When Talk uses another path, the picked model still
 * serves voice notes, so it is looked up in `mediaProviders` rather than that
 * path's providers.
 */
function preferredProviderEntry(catalog: CatalogState, preferredModel: string | null) {
  const loaded = loadedCatalog(catalog);
  if (!loaded || !preferredModel) {
    return undefined;
  }
  const providers =
    loaded.source === "media-understanding" ? loaded.providers : (loaded.mediaProviders ?? []);
  const id = splitModelRef(preferredModel)?.provider;
  return id ? providers.find((entry) => entry.id === id || entry.aliases?.includes(id)) : undefined;
}

export function TalkTranscriptionSection(props: TranscriptionProps) {
  const context = useApplication();
  const [rejectedModel, setRejectedModel] = createSignal<string | null>(null);
  const selection = createMemo(() => resolveTalkTranscriptionSelection(props.configObject));
  const preferredProvider = createMemo(() =>
    preferredProviderEntry(props.catalog, selection().preferredModel),
  );
  // Media-only providers keep their key in the Gateway's environment or
  // config, which Models cannot edit, so only listed providers link there.
  const keyInModels = () => {
    const provider = preferredProvider();
    return (
      provider !== undefined &&
      (props.modelKeyProviders?.includes(canonicalModelAuthProviderId(provider.id)) ?? true)
    );
  };
  const voiceNotesDescription = () => {
    const provider = preferredProvider();
    if (!provider || provider.configured) {
      return t("talkPage.transcription.voiceNotesDescription");
    }
    return t(
      keyInModels()
        ? "talkPage.transcription.providerNotReadyDescription"
        : "talkPage.transcription.providerKeyOutsideModels",
      { provider: providerDisplayLabel(provider.id) },
    );
  };
  const options = createMemo(() => {
    const { entries, preferredModel } = selection();
    const values = [
      { value: AUTOMATIC, label: t("talkPage.transcription.automatic") },
      ...entries.map((entry) => ({
        value: `${entry.provider}/${entry.model}`,
        label: entry.model,
        provider: entry.provider,
      })),
    ];
    if (preferredModel && !values.some((option) => option.value === preferredModel)) {
      values.push({ value: preferredModel, label: preferredModel });
    }
    return values;
  });
  return (
    <SettingsSection
      title={t("talkPage.transcription.title")}
      description={t("talkPage.transcription.description")}
    >
      <TalkRow
        catalog={props.catalog}
        preferredProviderId={
          preferredProvider()?.id ?? splitModelRef(selection().preferredModel ?? "")?.provider
        }
      />
      <SettingsRow
        title={t("talkPage.transcription.voiceNotesTitle")}
        description={
          rejectedModel() === null
            ? voiceNotesDescription()
            : t("talkPage.transcription.invalidModel", { value: rejectedModel()! })
        }
        role={rejectedModel() === null ? undefined : "alert"}
        control={
          <>
            <Show when={preferredProvider()}>
              {(provider) => (
                <SettingsStatus
                  kind={provider().configured ? "ok" : "warn"}
                  label={t(
                    provider().configured
                      ? "talkPage.status.ready"
                      : "talkPage.transcription.providerNotReady",
                  )}
                />
              )}
            </Show>
            <ModelPicker
              label={t("talkPage.transcription.modelTitle")}
              value={selection().preferredModel ?? AUTOMATIC}
              options={options()}
              disabled={props.configBusy}
              custom={{
                label: t("talkPage.transcription.custom"),
                placeholder: "openrouter/openai/whisper-large-v3-turbo",
                commit: "change",
                invalid: rejectedModel() !== null,
              }}
              onChange={(value) =>
                setRejectedModel(
                  changeTranscriptionModel(context.runtimeConfig, props.configObject, value)
                    ? null
                    : value.trim(),
                )
              }
            />
            <Show
              when={
                preferredProvider()?.configured === false && keyInModels() && preferredProvider()
              }
            >
              {(provider) => (
                <button
                  type="button"
                  class="btn"
                  onClick={() =>
                    navigateToModelProvider(context, selection().talkAgentId, provider().id)
                  }
                >
                  {t("talkPage.transcription.openModels")}
                </button>
              )}
            </Show>
          </>
        }
      />
    </SettingsSection>
  );
}
