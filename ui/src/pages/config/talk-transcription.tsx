// Speech-to-text rows for the Talk page. Talk dictation and Gateway-relay
// transcription read the shared media-understanding audio config
// (`tools.media.models` + `tools.media.audio.preferredModel`), the same keys the
// AI Agents → Tools schema editor exposes, so picks here patch that config
// draft rather than a Talk-only copy. Provider keys stay on Settings → Models;
// a missing key is reported here with a link there.
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readTrimmedString } from "@openclaw/normalization-core/string-coerce";
import { createMemo } from "solid-js";
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

export type TalkTranscriptionCatalog = TalkCatalogResult["transcription"];

type AudioModelEntry = { provider: string; model: string };

/** Audio-tagged `tools.media.models` entries plus the preferred pick, from the config draft. */
export function resolveTalkTranscriptionSelection(configObject: Record<string, unknown>) {
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
  const slash = ref.indexOf("/");
  return slash > 0 && slash < ref.length - 1
    ? { provider: ref.slice(0, slash), model: ref.slice(slash + 1) }
    : null;
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
 * stay and the runtime tries them in configured order.
 */
function changeTranscriptionModel(
  runtimeConfig: ReturnType<typeof useApplication>["runtimeConfig"],
  configObject: Record<string, unknown>,
  value: string,
) {
  const ref = value.trim();
  if (!ref) {
    runtimeConfig.removeFormValue(["tools", "media", "audio", "preferredModel"]);
    return;
  }
  const selection = resolveTalkTranscriptionSelection(
    runtimeConfig.state.configForm ?? configObject,
  );
  const parsed = splitModelRef(ref);
  if (
    parsed &&
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
}

/**
 * The provider whose credentials decide readiness: the preferred model's
 * provider, else the catalog's active pick, else the first audio entry.
 */
function chosenProvider(
  catalog: TalkTranscriptionCatalog,
  selection: ReturnType<typeof resolveTalkTranscriptionSelection>,
) {
  const id =
    (selection.preferredModel && splitModelRef(selection.preferredModel)?.provider) ??
    catalog.activeProvider ??
    selection.entries[0]?.provider;
  return id
    ? catalog.providers.find((entry) => entry.id === id || entry.aliases?.includes(id))
    : undefined;
}

function TranscriptionStatusRow(props: {
  catalog: TranscriptionProps["catalog"];
  selection: ReturnType<typeof resolveTalkTranscriptionSelection>;
}) {
  const context = useApplication();
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
    const provider = chosenProvider(catalog, props.selection);
    if (provider && !provider.configured) {
      return {
        kind: "warn" as const,
        label: t("talkPage.transcription.keyMissing"),
        description: t("talkPage.transcription.keyMissingDescription", {
          provider: provider.label,
        }),
        missingKeyProvider: provider.id,
      };
    }
    return {
      kind: catalog.ready ? ("ok" as const) : ("warn" as const),
      label: t(catalog.ready ? "talkPage.status.ready" : "talkPage.status.notReady"),
      description: catalog.activeProvider
        ? t("talkPage.status.activeProvider", { provider: catalog.activeProvider })
        : t("talkPage.transcription.noProvider"),
    };
  };
  const missingKeyProvider = () => {
    const current = status();
    return "missingKeyProvider" in current ? current.missingKeyProvider : null;
  };
  return (
    <SettingsRow
      title={t("talkPage.status.title")}
      description={status().description}
      control={
        <>
          <SettingsStatus kind={status().kind} label={status().label} />
          {missingKeyProvider() && (
            <button
              type="button"
              class="btn"
              onClick={() =>
                navigateToModelProvider(context, props.selection.talkAgentId, missingKeyProvider()!)
              }
            >
              {t("talkPage.transcription.openModels")}
            </button>
          )}
        </>
      }
    />
  );
}

export function TalkTranscriptionSection(props: TranscriptionProps) {
  const context = useApplication();
  const selection = createMemo(() => resolveTalkTranscriptionSelection(props.configObject));
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
      <TranscriptionStatusRow catalog={props.catalog} selection={selection()} />
      <SettingsRow
        title={t("talkPage.transcription.modelTitle")}
        description={t("talkPage.transcription.modelDescription")}
        control={
          <ModelPicker
            label={t("talkPage.transcription.modelTitle")}
            value={selection().preferredModel ?? AUTOMATIC}
            options={options()}
            disabled={props.configBusy}
            custom={{
              label: t("talkPage.transcription.custom"),
              placeholder: "openrouter/openai/whisper-large-v3-turbo",
              commit: "change",
            }}
            onChange={(value) =>
              changeTranscriptionModel(context.runtimeConfig, props.configObject, value)
            }
          />
        }
      />
    </SettingsSection>
  );
}
