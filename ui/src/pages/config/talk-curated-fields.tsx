import { asOptionalRecord as record } from "@openclaw/normalization-core/record-coerce";
import { createMemo, Show } from "solid-js";
import { ALL_THINKING_LEVELS } from "../../../../src/auto-reply/thinking.shared.js";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import { SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents } from "../../lib/reactive/domain-capabilities.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { SettingsPickerRow, SettingsSelectRow } from "./settings-select-row.tsx";
import { talkProviderStatus, talkProviderStatusLabel } from "./talk-status.ts";
import type { TalkCatalogState } from "./talk.tsx";

/** A config scalar as the string a control shows; objects and unset values show nothing. */
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";

type FieldsProps = { config?: Record<string, unknown>; disabled: boolean };
type FieldProps = FieldsProps & { title: string; path: string[] };

function useField(props: FieldProps) {
  const { runtimeConfig } = useApplication();
  const value = () => props.path.reduce<unknown>((node, key) => record(node)?.[key], props.config);
  const write = (next: string | number | boolean | undefined) => {
    if (props.disabled) {
      return;
    }
    if (next === undefined || next === "") {
      runtimeConfig.removeFormValue(props.path);
    } else {
      runtimeConfig.patchForm(props.path, next);
    }
  };
  return { value, write };
}

function TalkInput(
  props: FieldProps & { number?: { min: number; max?: number; step: number | "any" } },
) {
  const field = useField(props);
  const displayValue = createMemo(() => text(field.value()));
  return (
    <SettingsRow
      title={props.title}
      control={
        <input
          aria-label={props.title}
          disabled={props.disabled}
          type={props.number ? "number" : "text"}
          min={props.number?.min}
          max={props.number?.max}
          step={props.number?.step}
          ref={liveValue(displayValue)}
          placeholder={t("talkPage.revamp.defaultValue")}
          onChange={(event) => {
            const input = event.currentTarget;
            if (input.validity.valid) {
              field.write(
                props.number && input.value !== "" ? input.valueAsNumber : input.value.trim(),
              );
            }
          }}
        />
      }
    />
  );
}

function TalkChoice(
  props: FieldProps & {
    options: readonly { value: string; label: string }[];
    boolean?: boolean;
  },
) {
  const field = useField(props);
  const selected = () => text(field.value());
  return (
    <SettingsSelectRow
      title={props.title}
      disabled={props.disabled}
      value={selected()}
      options={[
        { value: "", label: t("talkPage.revamp.defaultValue") },
        ...props.options,
        ...(selected() && !props.options.some(({ value }) => value === selected())
          ? [{ value: selected(), label: selected() }]
          : []),
      ]}
      onChange={(value) => field.write(value && props.boolean ? value === "true" : value)}
    />
  );
}

function boolOptions() {
  return [
    { value: "true", label: t("talkPage.revamp.on") },
    { value: "false", label: t("talkPage.revamp.off") },
  ];
}

const choices = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

function TalkAgentPicker(props: FieldsProps) {
  const { agents, runtimeConfig } = useApplication();
  const roster = projectAgents(agents);
  const list = () => roster.read().agentsList;
  const selectable = () => listSelectableAgents(list()?.agents ?? []);
  const configured = () => text(record(props.config?.talk)?.agentId);
  const defaultName = () => {
    const entry = selectable().find(({ id }) => id === list()?.defaultId);
    return entry ? normalizeAgentLabel(entry) : list()?.defaultId;
  };
  return (
    <SettingsPickerRow
      title={t("talkPage.revamp.agent")}
      disabled={props.disabled}
      value={configured()}
      options={[
        {
          value: "",
          label: defaultName()
            ? t("talkPage.revamp.agentDefault", { agent: defaultName()! })
            : t("talkPage.revamp.defaultValue"),
        },
        ...selectable().map((entry) => ({ value: entry.id, label: normalizeAgentLabel(entry) })),
        ...(configured() && !selectable().some(({ id }) => id === configured())
          ? [{ value: configured(), label: configured() }]
          : []),
      ]}
      onChange={(value) =>
        value
          ? runtimeConfig.patchForm(["talk", "agentId"], value)
          : runtimeConfig.removeFormValue(["talk", "agentId"])
      }
    />
  );
}

export function TalkAgentSettings(props: FieldsProps) {
  const realtime = () => record(record(props.config?.talk)?.realtime);
  const consultDisabled = () =>
    props.disabled || (realtime()?.brain ?? "agent-consult") !== "agent-consult";
  return (
    <SettingsSection title={t("talkPage.revamp.agent")}>
      <TalkAgentPicker {...props} />
      <Show when={realtime()?.mode !== "stt-tts" && realtime()?.mode !== "transcription"}>
        <TalkChoice
          {...props}
          title={t("talkPage.revamp.thinking")}
          path={["talk", "consultThinkingLevel"]}
          disabled={consultDisabled()}
          options={choices(ALL_THINKING_LEVELS)}
        />
        <TalkChoice
          {...props}
          title={t("talkPage.revamp.fast")}
          path={["talk", "consultFastMode"]}
          disabled={consultDisabled()}
          options={boolOptions()}
          boolean
        />
      </Show>
    </SettingsSection>
  );
}

export function TalkLiveTuning(props: FieldsProps) {
  return (
    <SettingsDisclosure quiet title={t("talkPage.revamp.tuning")}>
      <TalkChoice
        {...props}
        title={t("talkPage.revamp.transport")}
        path={["talk", "realtime", "transport"]}
        options={choices(["webrtc", "provider-websocket", "gateway-relay", "managed-room"])}
      />
      <TalkInput
        {...props}
        title={t("talkPage.revamp.threshold")}
        path={["talk", "realtime", "vadThreshold"]}
        number={{ min: 0, max: 1, step: "any" }}
      />
      <TalkInput
        {...props}
        title={t("talkPage.revamp.silence")}
        path={["talk", "realtime", "silenceDurationMs"]}
        number={{ min: 1, step: 1 }}
      />
      <TalkInput
        {...props}
        title={t("talkPage.revamp.padding")}
        path={["talk", "realtime", "prefixPaddingMs"]}
        number={{ min: 0, step: 1 }}
      />
      <TalkInput
        {...props}
        title={t("talkPage.revamp.reasoning")}
        path={["talk", "realtime", "reasoningEffort"]}
      />
      <TalkInput
        {...props}
        title={t("talkPage.revamp.instructions")}
        path={["talk", "realtime", "instructions"]}
      />
      <TalkChoice
        {...props}
        title={t("talkPage.revamp.brain")}
        path={["talk", "realtime", "brain"]}
        options={choices(["agent-consult", "direct-tools", "none"])}
      />
      <TalkChoice
        {...props}
        title={t("talkPage.revamp.routing")}
        path={["talk", "realtime", "consultRouting"]}
        options={choices(["provider-direct", "force-agent-consult"])}
      />
    </SettingsDisclosure>
  );
}

const CUSTOM_COMMAND_PROVIDER = "tts-local-cli";

function CommandFields(props: FieldsProps) {
  const { runtimeConfig } = useApplication();
  const entry = () =>
    record(record(record(props.config?.talk)?.providers)?.[CUSTOM_COMMAND_PROVIDER]);
  const args = createMemo(() => {
    const value = entry()?.args;
    return Array.isArray(value) ? value.join("\n") : "";
  });
  return (
    <>
      <TalkInput
        {...props}
        title={t("talkPage.revamp.program")}
        path={["talk", "providers", CUSTOM_COMMAND_PROVIDER, "command"]}
      />
      <SettingsRow
        title={t("talkPage.revamp.arguments")}
        control={
          <textarea
            class="settings-input"
            aria-label={t("talkPage.revamp.arguments")}
            disabled={props.disabled}
            rows={3}
            ref={liveValue(args)}
            onChange={(event) => {
              const lines = event.currentTarget.value.split("\n").filter((line) => line !== "");
              const path = ["talk", "providers", CUSTOM_COMMAND_PROVIDER, "args"];
              if (lines.length === 0) {
                runtimeConfig.removeFormValue(path);
              } else {
                runtimeConfig.patchForm(path, lines);
              }
            }}
          />
        }
      />
    </>
  );
}

export function TalkSplitVoice(props: FieldsProps & { catalog: TalkCatalogState }) {
  const { runtimeConfig } = useApplication();
  const speech = () => (props.catalog.kind === "ready" ? props.catalog.speech : undefined);
  const selected = () => text(record(props.config?.talk)?.provider);
  const catalogIds = () => new Set(speech()?.providers.map(({ id }) => id));
  // Engines the user configured by hand appear by name; no engine detection.
  const entries = () => Object.keys(record(record(props.config?.talk)?.providers) ?? {});
  const configured = () =>
    entries().filter((id) => !catalogIds().has(id) && id !== CUSTOM_COMMAND_PROVIDER);
  // The Gateway rejects talk.provider outside a non-empty talk.providers map, and an unset
  // provider next to several entries, so those choices are shown but cannot be picked.
  const outsideEntries = (id: string) =>
    entries().length > 0 && !entries().some((key) => key.toLowerCase() === id.toLowerCase());
  return (
    <SettingsSection title={t("talkPage.revamp.voice")}>
      <Show
        when={speech() || entries().length > 0}
        fallback={
          <TalkInput {...props} title={t("talkPage.provider.title")} path={["talk", "provider"]} />
        }
      >
        <SettingsPickerRow
          title={t("talkPage.provider.title")}
          disabled={props.disabled}
          value={selected()}
          options={[
            {
              value: "",
              label: t("talkPage.revamp.defaultValue"),
              disabled: entries().length > 1,
            },
            ...(speech()?.providers.map(({ id, label, configured: ready }) => ({
              value: id,
              label,
              description: talkProviderStatusLabel(
                talkProviderStatus(speech(), { id, configured: ready }),
              ),
              group: t("talkPage.revamp.groupCloud"),
              disabled: outsideEntries(id),
            })) ?? []),
            ...configured().map((id) => ({
              value: id,
              label: id,
              group: t("talkPage.revamp.groupConfigured"),
            })),
            { value: CUSTOM_COMMAND_PROVIDER, label: t("talkPage.revamp.customCommand") },
          ]}
          onChange={(next) =>
            next
              ? runtimeConfig.patchForm(["talk", "provider"], next)
              : runtimeConfig.removeFormValue(["talk", "provider"])
          }
        />
      </Show>
      <Show when={selected() === CUSTOM_COMMAND_PROVIDER}>
        <CommandFields {...props} />
      </Show>
      <TalkInput
        {...props}
        title={t("talkPage.revamp.silenceBeforeSend")}
        path={["talk", "silenceTimeoutMs"]}
        number={{ min: 1, step: 1 }}
      />
      <TalkChoice
        {...props}
        title={t("talkPage.revamp.interrupt")}
        path={["talk", "interruptOnSpeech"]}
        options={boolOptions()}
        boolean
      />
    </SettingsSection>
  );
}

export function TalkSpeechLocale(props: FieldsProps) {
  return (
    <TalkInput
      {...props}
      title={t("talkPage.revamp.speechLocale")}
      path={["talk", "speechLocale"]}
    />
  );
}
