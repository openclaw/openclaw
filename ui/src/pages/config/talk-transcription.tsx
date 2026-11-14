// Speech-to-text rows for the Talk page. Talk dictation and Gateway-relay
// transcription read the shared media-understanding audio config
// (`tools.media.models` + `tools.media.audio.preferredModel`), the same keys the
// AI Agents → Tools schema editor exposes, so picks here patch that config
// draft rather than a Talk-only copy. Provider keys stay on Settings → Models;
// a missing key is reported here with a link there.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { createMemo, createSignal, Show } from "solid-js";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { navigateToModelProvider } from "../model-providers/navigation.ts";

const AUTOMATIC = "";

type TalkTranscriptionCatalog = TalkCatalogResult["transcription"];

// Status copy for the path the Gateway reports Talk uses (talk.catalog `source`).
const SOURCE_STATUS_KEYS = {
  streaming: "talkPage.transcription.sourceStreaming",
  "voice-model": "talkPage.transcription.sourceVoiceModel",
  "media-understanding": "talkPage.transcription.sourceMediaUnderstanding",
} as const;

/** The picked model drives Talk only on the media-understanding path. */
function talkUsesPickedModel(source: TalkTranscriptionCatalog["source"]) {
  return source === "media-understanding";
}

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

function TranscriptionStatusRow(props: { catalog: TranscriptionProps["catalog"] }) {
  const status = () => {
    const catalog = props.catalog;
    if (catalog === "loading" || catalog === "unavailable") {
      return {
        kind: "muted" as const,
        label: t(catalog === "loading" ? "common.loading" : "talkPage.status.unavailable"),
        description:
          catalog === "unavailable" ? t("talkPage.transcription.unavailableHint") : "\u00a0",
      };
    }
    if ("failed" in catalog) {
      return {
        kind: "muted" as const,
        label: t("talkPage.status.unavailable"),
        description: formatUiError(catalog.failed, t("talkPage.transcription.failedHint")),
      };
    }
    return {
      kind: catalog.ready ? ("ok" as const) : ("warn" as const),
      label: t(catalog.ready ? "talkPage.status.ready" : "talkPage.status.notReady"),
      // A ready route without a provider id is a local CLI model, not a missing one.
      description:
        catalog.activeProvider && catalog.source
          ? t(SOURCE_STATUS_KEYS[catalog.source], { provider: catalog.activeProvider })
          : t(
              catalog.ready
                ? "talkPage.transcription.readyWithoutProvider"
                : "talkPage.transcription.noProvider",
            ),
    };
  };
  return (
    <SettingsRow
      title={t("talkPage.status.title")}
      description={status().description}
      control={<SettingsStatus kind={status().kind} label={status().label} />}
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
function preferredProviderEntry(
  catalog: TranscriptionProps["catalog"],
  preferredModel: string | null,
) {
  if (typeof catalog === "string" || "failed" in catalog || !preferredModel) {
    return undefined;
  }
  const providers = talkUsesPickedModel(catalog.source)
    ? catalog.providers
    : (catalog.mediaProviders ?? []);
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
  const modelDescription = () => {
    const catalog = props.catalog;
    // Until the catalog answers, the page states the precedence rule instead
    // of a path it does not know yet.
    const usage =
      typeof catalog !== "object" || "failed" in catalog
        ? t("talkPage.transcription.modelDescription")
        : talkUsesPickedModel(catalog.source)
          ? t("talkPage.transcription.modelDescriptionTalk")
          : t("talkPage.transcription.modelDescriptionVoiceNotes");
    const provider = preferredProvider();
    return provider && !provider.configured
      ? `${t("talkPage.transcription.providerNotReadyDescription", { provider: provider.label })} ${usage}`
      : usage;
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
      <TranscriptionStatusRow catalog={props.catalog} />
      <SettingsRow
        title={t("talkPage.transcription.modelTitle")}
        description={
          rejectedModel() === null
            ? modelDescription()
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
            <Show when={preferredProvider()?.configured === false && preferredProvider()}>
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
