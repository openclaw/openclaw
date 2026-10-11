import type { TranscriptsStatusResult } from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { JSX } from "@solidjs/web";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsNavRow,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { registerTranscriptsEnglish } from "../../i18n/locales/en-transcripts.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { COMMUNICATION_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
registerEnglishCatalog(registerTranscriptsEnglish);

const LOCATOR_FIELDS = ["accountId", "guildId", "channelId", "meetingUrl"] as const;
const SOURCE_FIELDS = ["title", ...LOCATOR_FIELDS, "sessionId"] as const;
type SourceProvider = TranscriptsStatusResult["providers"][number];

function supportsAutoStartSetup(provider: SourceProvider | undefined): boolean {
  return (
    provider?.availability === "enabled" &&
    provider.canStart !== false &&
    Boolean(provider.autoStart)
  );
}

type SettingsProps = {
  mutationDisabled: boolean;
  buildEditor: (() => JSX.Element) | undefined;
  advancedExpanded: boolean;
};
export function MeetingCaptureSettingsContent(props: SettingsProps) {
  const context = useApplication();
  const gatewayProjection = projectGateway(context.gateway);
  const configProjection = projectRuntimeConfig(context.runtimeConfig);
  const gateway = createGatewayConnectionLifecycle(context.gateway.snapshot);
  let disposed = false;
  let request: AbortController | undefined;
  const [requestStatus, setRequestStatus] = createSignal<"idle" | "pending" | "complete" | "error">(
    untrack(client) ? "pending" : "idle",
  );
  const [requestError, setRequestError] = createSignal<unknown>();
  const [result, setResult] = createSignal<
    { status: TranscriptsStatusResult; isCurrent: () => boolean } | undefined
  >();
  const [refreshRevision, setRefreshRevision] = createSignal(0);
  function refreshStatus() {
    setRefreshRevision((value) => value + 1);
  }
  function client() {
    gatewayProjection.read();
    const snapshot = context.gateway.snapshot;
    return !disposed &&
      snapshot.phase === "connected" &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null)
      ? snapshot.client
      : null;
  }
  const [editing, setEditing] = createSignal<number | "new" | null>(null);
  const [editError, setEditError] = createSignal<string | null>(null);
  const [editedProviderId, setEditedProviderId] = createSignal("");
  const [locatorRequirements, setLocatorRequirements] = createSignal<SourceProvider["autoStart"]>();
  let editedSource: unknown;
  let sourceDraft: Record<string, unknown> = {};
  let originalLocatorRequirements: SourceProvider["autoStart"];
  let previousHello = context.gateway.snapshot.hello;
  let previousAuth = previousHello?.auth;
  function synchronizeConnection() {
    const snapshot = context.gateway.snapshot;
    const transition = gateway.transition(snapshot);
    const identityChanged =
      previousHello !== snapshot.hello || previousAuth !== snapshot.hello?.auth;
    if (identityChanged) {
      gateway.invalidate();
    }
    previousHello = snapshot.hello;
    previousAuth = snapshot.hello?.auth;
    if (transition || identityChanged) {
      request?.abort();
      refreshStatus();
    }
  }
  const unsubscribeGateway = gatewayProjection.subscribe(synchronizeConnection);
  onCleanup(unsubscribeGateway);
  const requestKey = createMemo(
    () => {
      const snapshot = gatewayProjection.read().snapshot;
      return [
        client(),
        snapshot.phase,
        snapshot.hello,
        snapshot.hello?.auth,
        configProjection.read().state.configSnapshot?.hash,
        refreshRevision(),
      ] as const;
    },
    { equals: (previous, next) => previous.every((value, index) => value === next[index]) },
  );
  createEffect(requestKey, ([currentClient, , hello, auth, hash], previous) => {
    request?.abort();
    if (!currentClient) {
      if (previous) {
        setRequestStatus("idle");
      }
      return undefined;
    }
    const controller = new AbortController();
    request = controller;
    const scope = gateway.capture();
    const currentGateway = context.gateway;
    const isConnectionCurrent = () =>
      client() === currentClient &&
      scope !== null &&
      gateway.isCurrent(scope) &&
      context.gateway === currentGateway &&
      currentGateway.snapshot.hello === hello &&
      hello?.auth === auth &&
      context.runtimeConfig.state.configSnapshot?.hash === hash;
    const isCurrent = () =>
      !controller.signal.aborted && request === controller && isConnectionCurrent();
    if (previous) {
      setRequestStatus("pending");
    }
    void currentClient
      .request<TranscriptsStatusResult>("transcripts.status", {}, { signal: controller.signal })
      .then(
        (status) =>
          untrack(() => {
            if (!isCurrent()) {
              return;
            }
            setResult({ status, isCurrent: isConnectionCurrent });
            setRequestStatus("complete");
            retainLocatorRequirements(status, editing(), editedProviderId(), locatorRequirements());
          }),
        (error: unknown) => {
          if (!isCurrent()) {
            return;
          }
          // Failed health must not seed a later editor with stale provider requirements.
          setResult(undefined);
          setRequestError(error);
          setRequestStatus("error");
        },
      );
    return () => controller.abort();
  });
  onCleanup(() => {
    disposed = true;
    request?.abort();
    gateway.dispose();
  });
  function disabled() {
    configProjection.read();
    gatewayProjection.read();
    const config = context.runtimeConfig;
    return (
      props.mutationDisabled ||
      !config.canSet ||
      !config.state.connected ||
      config.state.configLoading ||
      config.state.configSaving ||
      config.state.configApplying ||
      rawDraftPending() ||
      !hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null)
    );
  }
  function rawDraftPending() {
    configProjection.read();
    gatewayProjection.read();
    const configState = context.runtimeConfig.state;
    // A whole source-array edit cannot safely be built from the parsed snapshot
    // while the authoritative raw buffer contains a different source list.
    return configState.configFormMode === "raw" && configState.configFormDirty;
  }
  function transcriptConfig() {
    configProjection.read();
    gatewayProjection.read();
    const configState = context.runtimeConfig.state;
    return asNullableRecord(
      asNullableRecord(configState.configForm ?? configState.configSnapshot?.config)?.transcripts,
    );
  }
  function sources(): unknown[] {
    const value = transcriptConfig()?.autoStart;
    return Array.isArray(value) ? value : [];
  }
  function editSource(index: number | "new" | null) {
    // The keyed form survives same-editor clicks. Keep its draft and captured
    // source together until Cancel, save, or a different editor ends ownership.
    if (editing() === index) {
      return;
    }

    editedSource = typeof index === "number" ? sources()[index] : undefined;
    sourceDraft = { ...asNullableRecord(editedSource) };
    setLocatorRequirements((originalLocatorRequirements = undefined));
    const providerId = asNullableRecord(editedSource)?.providerId;
    setEditedProviderId(typeof providerId === "string" ? providerId : "");
    setEditing(index);
    retainLocatorRequirements(
      knownCaptureStatus(),
      index,
      typeof providerId === "string" ? providerId : "",
    );
    setEditError(null);
  }
  function selectProvider(providerId: string) {
    if (editedProviderId() !== providerId) {
      setLocatorRequirements(undefined);
    }
    const known = editedProviderId() === providerId ? locatorRequirements() : undefined;
    setEditedProviderId(providerId);
    retainLocatorRequirements(knownCaptureStatus(), editing(), providerId, known);
  }
  function retainLocatorRequirements(
    status: TranscriptsStatusResult | null,
    index = editing(),
    providerId = editedProviderId(),
    known?: SourceProvider["autoStart"],
  ) {
    if (index === null) {
      return;
    }
    const retain = (candidateId: unknown, existing: SourceProvider["autoStart"]) => {
      const requirements = status?.providers.find(
        (provider) => provider.providerId === normalizeOptionalString(candidateId),
      )?.autoStart;
      return requirements ? { ...existing, ...requirements } : existing;
    };
    // Returning to the authored source still allows edits after health fails.
    // Temporary provider choices must not erase its validation or confer availability.
    const originalProviderId = asNullableRecord(editedSource)?.providerId;
    originalLocatorRequirements = retain(originalProviderId, originalLocatorRequirements);
    setLocatorRequirements(
      normalizeOptionalString(providerId) === normalizeOptionalString(originalProviderId)
        ? originalLocatorRequirements
        : retain(providerId, known),
    );
  }
  function saveSource(event: SubmitEvent) {
    event.preventDefault();
    const index = editing();
    if (disabled() || index === null) {
      return;
    }
    const updatedSources = [...sources()];
    if (index !== "new" && updatedSources[index] !== editedSource) {
      setEditError(t("meetingCapture.sourceChanged"));
      return;
    }
    // SAFETY: SourceEditor calls this synchronously from its native form's submit binding.
    const form = event.currentTarget as HTMLFormElement;
    if (!form.reportValidity()) {
      return;
    }
    const data = new FormData(form);
    const source = { ...asNullableRecord(editedSource) };
    const providerId = normalizeOptionalString(data.get("providerId"));
    const provider = captureStatus()?.providers.find((item) => item.providerId === providerId);
    if (
      (index === "new" || editedProviderId() !== source.providerId) &&
      !supportsAutoStartSetup(provider)
    ) {
      setEditError(t("meetingCapture.autoStartUnavailable"));
      return;
    }
    for (const key of ["providerId", ...SOURCE_FIELDS]) {
      // Drafts record input events; browser URL sanitization must not turn an
      // untouched value into an edit. Absent controls still preserve configured fields.
      const draftValue = key === "providerId" ? editedProviderId() : sourceDraft[key];
      if (!data.has(key) || (index !== "new" && draftValue === source[key])) {
        continue;
      }
      const value = normalizeOptionalString(data.get(key));
      if (value) {
        source[key] = value;
      } else {
        delete source[key];
      }
    }
    const missing = LOCATOR_FIELDS.find(
      (key) => locatorRequirements()?.[key] === "required" && !normalizeOptionalString(source[key]),
    );
    if (missing) {
      setEditError(
        t("meetingCapture.requiredLocator", {
          field: t(`meetingCapture.fields.${missing}`),
        }),
      );
      return;
    }
    if (index === "new") {
      updatedSources.push(source);
    } else {
      updatedSources[index] = source;
    }
    context.runtimeConfig.patchForm(["transcripts", "autoStart"], updatedSources);
    editSource(null);
  }
  function knownCaptureStatus() {
    // A pending health refresh retains the last status from the current connection.
    // Only the original request owner can seed an editor's validation rules.
    const currentResult = result();
    return currentResult?.isCurrent() ? currentResult.status : null;
  }
  function captureStatus() {
    return requestStatus() === "complete" ? knownCaptureStatus() : null;
  }
  function SourceEditor(editorProps: { index: number | "new" }) {
    const source = sourceDraft;
    const providers = () =>
      captureStatus()
        ?.providers.filter(supportsAutoStartSetup)
        .toSorted((a, b) => a.name.localeCompare(b.name)) ?? [];
    const configuredProvider = typeof source?.providerId === "string" ? source.providerId : "";
    const providerOptions = () =>
      providers().map((provider) => ({
        id: provider.providerId,
        label: `${provider.name} · ${t(`meetingCapture.availability.${provider.availability}`)}`,
      }));
    const options = createMemo(() => {
      const available = providerOptions();
      for (const id of [configuredProvider, editedProviderId()]) {
        if (id && !available.some((option) => option.id === id)) {
          available.push({ id, label: id });
        }
      }

      return available;
    });
    const selectedProvider = () =>
      captureStatus()?.providers.find((item) => item.providerId === editedProviderId());
    const fields = () =>
      [
        "title",
        ...LOCATOR_FIELDS.filter(
          (key) => locatorRequirements()?.[key] || source?.[key] !== undefined,
        ),
        "sessionId",
      ] as const;
    return (
      <form onSubmit={(event: SubmitEvent) => saveSource(event)}>
        <SettingsSection
          title={t(
            editorProps.index === "new" ? "meetingCapture.addSource" : "meetingCapture.editSource",
          )}
        >
          <>
            <SettingsRow
              title={t("meetingCapture.fields.providerId")}
              control={
                <select
                  class="settings-select"
                  name="providerId"
                  aria-label={t("meetingCapture.fields.providerId")}
                  required
                  disabled={disabled()}
                  value={editedProviderId()}
                  onChange={(event: Event) => {
                    // SAFETY: This native select emits the change event handled by its own binding.
                    selectProvider((event.target as HTMLSelectElement).value);
                  }}
                >
                  <option value="">{t("meetingCapture.chooseProvider")}</option>
                  <For each={options()} keyed={(option) => option.id}>
                    {(option) => (
                      <option value={option().id} selected={option().id === editedProviderId()}>
                        {option().label}
                      </option>
                    )}
                  </For>
                </select>
              }
            />
            {editedProviderId() && !supportsAutoStartSetup(selectedProvider()) ? (
              <SettingsEmpty message={t("meetingCapture.autoStartUnavailable")} />
            ) : undefined}
            <For each={fields()}>
              {(key) => (
                <SettingsRow
                  title={t(`meetingCapture.fields.${key}`)}
                  description={
                    key === "sessionId"
                      ? t(
                          source.whenOccupied === true
                            ? "meetingCapture.occupancySessionIdHint"
                            : "meetingCapture.sessionIdHint",
                        )
                      : key === "title"
                        ? t("meetingCapture.titleHint")
                        : undefined
                  }
                  control={
                    <input
                      class="settings-input"
                      name={key}
                      type={key === "meetingUrl" ? "url" : "text"}
                      aria-label={t(`meetingCapture.fields.${key}`)}
                      disabled={disabled() || (key === "sessionId" && source.whenOccupied === true)}
                      required={
                        key !== "title" &&
                        key !== "sessionId" &&
                        locatorRequirements()?.[key] === "required"
                      }
                      value={typeof source?.[key] === "string" ? source[key] : ""}
                      onInput={(event: Event) => {
                        // Health refreshes can remove metadata; unsaved locators must survive.
                        // SAFETY: This native input emits the input event handled by its own binding.
                        sourceDraft[key] = (event.target as HTMLInputElement).value;
                      }}
                    />
                  }
                />
              )}
            </For>
            <SettingsRow
              title={t("meetingCapture.locatorsHint")}
              control={
                <>
                  {" "}
                  <button
                    type="button"
                    class="btn"
                    onClick={() => {
                      editSource(null);
                    }}
                  >
                    {t("common.cancel")}
                  </button>
                  <button type="submit" class="btn" disabled={disabled() || !editedProviderId()}>
                    {t("meetingCapture.saveSource")}
                  </button>
                </>
              }
            />
            {editError() ? (
              <SettingsEmpty message={<span role="alert">{editError()}</span>} />
            ) : undefined}
          </>
        </SettingsSection>
      </form>
    );
  }

  const status = captureStatus;
  const error = () => (requestStatus() === "error" ? formatUiError(requestError()) : null);
  const saved = () => status()?.latestTranscript;
  const sourceRows = () =>
    sources().map((raw, index) => {
      const source = asNullableRecord(raw);
      const provider = status()?.providers.find((item) => item.providerId === source?.providerId);
      return (
        <SettingsRow
          title={
            typeof source?.title === "string"
              ? source.title
              : (normalizeOptionalString(source?.providerId) ?? t("transcripts.unknown"))
          }
          description={[provider?.name, ...LOCATOR_FIELDS.map((key) => source?.[key])]
            .filter((value) => typeof value === "string" && value)
            .join(" · ")}
          control={
            <>
              <button
                class="btn"
                disabled={disabled()}
                aria-label={t("meetingCapture.editSourceNumber", { number: String(index + 1) })}
                onClick={() => editSource(index)}
              >
                <Icon name="edit" />
                {t("meetingCapture.edit")}
              </button>
              <button
                class="btn"
                disabled={disabled()}
                aria-label={t("meetingCapture.removeSourceNumber", { number: String(index + 1) })}
                onClick={() => {
                  if (disabled()) {
                    return;
                  }
                  context.runtimeConfig.patchForm(
                    ["transcripts", "autoStart"],
                    sources().filter((_, position) => position !== index),
                  );
                  editSource(null);
                }}
              >
                <Icon name="trash" />
                {t("common.remove")}
              </button>
            </>
          }
        />
      );
    });
  return (
    <>
      <SettingsPage>
        <div class="settings-stack" id={COMMUNICATION_SETTINGS_TARGET_IDS.meetingCapture}>
          <SettingsSection
            title={t("meetingCapture.title")}
            description={t("meetingCapture.description")}
          >
            <>
              <SettingsToggleRow
                title={t("meetingCapture.enabled")}
                description={t("meetingCapture.enabledHint")}
                checked={transcriptConfig()?.enabled !== false}
                disabled={disabled()}
                onChange={(enabled) => {
                  if (!disabled()) {
                    context.runtimeConfig.patchForm(["transcripts", "enabled"], enabled);
                  }
                }}
              />
              <SettingsNavRow
                title={t("transcripts.library")}
                description={t("meetingCapture.libraryHint")}
                onClick={() => context.navigate("meetings")}
              />
              <SettingsRow
                title={t("meetingCapture.observedState")}
                description={t("meetingCapture.stateHint")}
                control={
                  <SettingsStatus
                    kind={"muted"}
                    label={t(
                      status()
                        ? status()!.enabled
                          ? "meetingCapture.states.enabled"
                          : "meetingCapture.states.disabled"
                        : "meetingCapture.states.unknown",
                    )}
                  />
                }
              />
              <SettingsRow
                title={t("meetingCapture.latestTranscript")}
                description={
                  saved()
                    ? saved()!.title
                    : t(status() ? "meetingCapture.noSaved" : "transcripts.unknown")
                }
                control={
                  <SettingsValue
                    value={
                      saved()
                        ? t("transcripts.savedCount", {
                            count: String(saved()!.utteranceCount),
                          })
                        : t("transcripts.unknown")
                    }
                  />
                }
              />
              {saved() ? (
                <SettingsRow
                  title={t("meetingCapture.lastUtterance")}
                  control={
                    <SettingsValue
                      value={
                        saved()!.lastUtteranceAt
                          ? new Date(saved()!.lastUtteranceAt).toLocaleString()
                          : t("transcripts.unknown")
                      }
                    />
                  }
                />
              ) : undefined}
              <SettingsRow
                title={t("meetingCapture.health")}
                control={
                  <button
                    class="btn"
                    disabled={!client() || requestStatus() === "pending"}
                    onClick={() => refreshStatus()}
                  >
                    <Icon name="refresh" />
                    {t("common.refresh")}
                  </button>
                }
              />
              {error() ? (
                <SettingsEmpty
                  message={
                    <span role="alert">
                      {t("meetingCapture.healthError")} {error()}
                    </span>
                  }
                />
              ) : undefined}
              {requestStatus() === "pending" ? (
                <SettingsEmpty message={<span role="status">{t("common.loading")}</span>} />
              ) : undefined}
              {!hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null) ? (
                <SettingsEmpty message={t("configView.adminRequired")} />
              ) : undefined}
              {rawDraftPending() ? (
                <SettingsEmpty message={t("meetingCapture.rawDraftPending")} />
              ) : undefined}
            </>
          </SettingsSection>
          <SettingsSection
            title={t("meetingCapture.sources")}
            description={t("meetingCapture.sourcesHint")}
            actions={
              <button
                class="btn"
                disabled={disabled() || !status()?.providers.some(supportsAutoStartSetup)}
                onClick={() => editSource("new")}
              >
                <Icon name="plus" />
                {t("meetingCapture.addSource")}
              </button>
            }
          >
            {sources().length ? (
              sourceRows()
            ) : (
              <SettingsEmpty message={t("meetingCapture.noSources")} />
            )}
          </SettingsSection>
          <Show when={editing() !== null ? { index: editing() } : undefined} keyed>
            {(selection) => <SourceEditor index={selection.index!} />}
          </Show>
          {status() && !status()!.providers.some(supportsAutoStartSetup) ? (
            <SettingsEmpty message={t("meetingCapture.noAutoStartProviders")} />
          ) : undefined}
          {status()?.configuredSources.length ? (
            <SettingsSection
              title={t("meetingCapture.sourceHealth")}
              description={t("meetingCapture.armedHint")}
            >
              <For each={status()!.configuredSources}>
                {(item) => (
                  <SettingsRow
                    title={item.title ?? item.source.providerId}
                    description={[
                      ...LOCATOR_FIELDS.map((key) => item.source[key]),
                      item.startDiagnostic
                        ? t(`meetingCapture.startDiagnostics.${item.startDiagnostic}`)
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    control={
                      <SettingsStatus
                        kind={"muted"}
                        label={t(`meetingCapture.states.${item.state}`)}
                      />
                    }
                  />
                )}
              </For>
            </SettingsSection>
          ) : undefined}
          {status() && Object.values(status()!.omitted).some((count) => count > 0) ? (
            <p class="settings-page__intro">
              {t("meetingCapture.omitted", {
                count: String(
                  Object.values(status()!.omitted).reduce((sum, count) => sum + count, 0),
                ),
              })}
            </p>
          ) : undefined}
          <p class="settings-page__intro">{t("meetingCapture.safetyHint")}</p>
          <p class="settings-page__intro">{t("meetingCapture.durationHint")}</p>
          <p class="settings-page__intro">{t("meetingCapture.sttHint")}</p>
        </div>
      </SettingsPage>
      <ShellLayoutBoundary traits={{ settingsPage: true }}>
        <details class="settings-page" open={props.advancedExpanded}>
          <summary class="settings-section__heading">
            {t("meetingCapture.advancedSettings")}
          </summary>
          {props.buildEditor?.()}
        </details>
      </ShellLayoutBoundary>
    </>
  );
}

export const MeetingCaptureSettings = defineSolidBridge<SettingsProps>(
  "openclaw-meeting-capture-settings",
  (props) => <MeetingCaptureSettingsContent {...props} />,
  {
    properties: {
      mutationDisabled: { default: false, type: Boolean },
      buildEditor: { default: undefined, attribute: false },
      advancedExpanded: { default: false, type: Boolean },
    },
  },
);
