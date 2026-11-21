import type { BackupStatusResult, StorageLocationsProbeResult } from "@openclaw/gateway-protocol";
import { Errored, For, Loading, Show, createSignal, onSettled } from "solid-js";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import {
  SettingsEmpty,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsUnavailable,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatByteSize, formatDateTimeMs, formatTimeAgo } from "../../lib/format.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createSettingsStatus } from "./settings-status.ts";

registerEnglishCatalog(registerSettingsEnglish);

type Target = BackupStatusResult["targets"][number];
type Schedule = BackupStatusResult["schedules"][number];

const byteFormat = {
  style: "legacy-binary",
  separator: " ",
  maxUnit: "tera",
  fractionDigits: 0,
} as const;

const nextRun = (atMs: number) =>
  t("configView.backups.nextRun", {
    time: formatDateTimeMs(atMs, { dateStyle: "short", timeStyle: "short" }),
  });

function matchesSchedule(target: Target, schedule: Schedule) {
  return (
    schedule.enabled &&
    schedule.target === target.target &&
    (schedule.mode === "offsite"
      ? target.kind === "archive" && schedule.namespace === target.namespace
      : target.kind === "git")
  );
}

function renderTarget(target: Target, status: BackupStatusResult) {
  const { latest, latestOk } = target;
  const pushFailed = target.kind === "git" && latest.status === "ok" && latest.pushFailed === true;
  const failed = latest.status === "failed" || pushFailed;
  const storedLocation = latest.location ?? latestOk?.location;
  const location = status.locations.find(
    (entry) =>
      entry.name ===
      (storedLocation?.name ?? (target.kind === "archive" ? target.target : undefined)),
  );
  const nextRunAtMs = status.schedules
    .filter((entry) => matchesSchedule(target, entry))
    .reduce<number | undefined>(
      (next, entry) =>
        entry.nextRunAtMs === undefined ? next : Math.min(next ?? Infinity, entry.nextRunAtMs),
      undefined,
    );
  const size = latestOk?.location?.storedBytes ?? latestOk?.bytes;
  return (
    <>
      <SettingsRow
        title={storedLocation?.name ?? target.target}
        description={[
          t("configView.backups.kinds." + target.kind),
          t(pushFailed ? "configView.backups.lastLocalSuccess" : "configView.backups.lastSuccess", {
            age: latestOk
              ? formatTimeAgo(Math.max(0, Date.now() - latestOk.createdAt))
              : t("configView.backups.never"),
          }),
          size === undefined ? undefined : formatByteSize(size, byteFormat),
          nextRunAtMs === undefined ? undefined : nextRun(nextRunAtMs),
          location?.displayTarget ?? target.target,
          target.namespace === undefined
            ? undefined
            : t("configView.backups.namespace", { name: target.namespace }),
        ]
          .filter(Boolean)
          .join(" · ")}
        control={
          <SettingsStatus
            kind={failed ? "danger" : "ok"}
            label={t(
              pushFailed
                ? "configView.backups.pushFailed"
                : failed
                  ? "configView.backups.failed"
                  : "configView.backups.ok",
            )}
          />
        }
      />
      {failed ? (
        <SettingsEmpty
          message={
            latest.error ??
            t(pushFailed ? "configView.backups.pushFailureHint" : "configView.backups.failureHint")
          }
        />
      ) : undefined}
    </>
  );
}

/** Backup health for the Gateway; storage checks run only when the operator asks. */
export function BackupsSettings() {
  const context = useApplication();
  const configHash = () => context.runtimeConfig.state.configSnapshot?.hash;
  type Probe = { hash: ReturnType<typeof configHash>; result: StorageLocationsProbeResult };
  const probeRequests = new Map<string, AbortController>();
  const [probes, setProbes] = createSignal<ReadonlyMap<string, Probe>>(new Map());
  const [probing, setProbing] = createSignal<ReadonlySet<string>>(new Set());
  function retireProbes() {
    probeRequests.forEach((request) => request.abort());
    probeRequests.clear();
    setProbing(new Set<string>());
    setProbes(new Map());
  }
  const {
    client,
    pending,
    read: readStatus,
    result,
    scopeKey,
    requestKey,
    refresh,
    capture,
    configProjection,
  } = createSettingsStatus<BackupStatusResult>(context, {
    method: "backup.status",
    access: hasOperatorReadAccess,
    configHash: "hash",
    // Every connection receipt retires storage checks started on the previous one.
    onConnectionChange: retireProbes,
  });
  onSettled(() => () => probeRequests.forEach((request) => request.abort()));
  async function probe(name: string) {
    const currentClient = client();
    const ownsConnection = capture();
    if (!currentClient || probeRequests.has(name)) {
      return;
    }
    const request = new AbortController();
    const hash = configHash();
    probeRequests.set(name, request);
    setProbing((names) => new Set(names).add(name));
    setProbes((current) => {
      const next = new Map(current);
      next.delete(name);
      return next;
    });
    let probeResult: StorageLocationsProbeResult;
    try {
      probeResult = await currentClient.request<StorageLocationsProbeResult>(
        "storage.locations.probe",
        { name },
        { signal: request.signal },
      );
    } catch (error) {
      probeResult = { state: "error", message: formatUiError(error) };
    }
    if (probeRequests.get(name) !== request || !ownsConnection()) {
      return;
    }
    probeRequests.delete(name);
    setProbing((names) => {
      const next = new Set(names);
      next.delete(name);
      return next;
    });
    setProbes((current) => new Map(current).set(name, { hash, result: probeResult }));
  }
  // A config change can retarget a location, so a check only describes the config it ran under.
  const probeFor = (name: string) => {
    configProjection.read();
    const entry = probes().get(name);
    return entry && entry.hash === configHash() ? entry.result : undefined;
  };
  // Locations follow the retained status; checks stay disabled until the connection returns.
  const locations = () => result()?.status.locations ?? [];
  const unscheduled = (status: BackupStatusResult) =>
    status.schedules.filter(
      (schedule) =>
        schedule.enabled && !status.targets.some((target) => matchesSchedule(target, schedule)),
    );
  return (
    <>
      <SettingsSection
        title={t("configView.backups.title")}
        description={t("configView.backups.description")}
        actions={
          <RefreshButton
            label={t("configView.backups.refresh")}
            busy={pending()}
            disabled={!client()}
            onClick={() => refresh()}
          />
        }
      >
        <Errored
          fallback={(error) => (
            <SettingsEmpty
              message={
                pending() ? (
                  t("configView.backups.loading")
                ) : (
                  <span role="alert">{formatUiError(error())}</span>
                )
              }
            />
          )}
        >
          <Loading
            on={[scopeKey(), result() ? undefined : requestKey()]}
            fallback={<SettingsEmpty message={t("configView.backups.loading")} />}
          >
            <Show
              when={readStatus()?.status}
              keyed
              fallback={
                client() ? (
                  <SettingsEmpty message={t("configView.backups.loading")} />
                ) : (
                  <SettingsUnavailable
                    message={t(
                      context.gateway.snapshot.phase === "connected"
                        ? "configView.backups.readAccessRequired"
                        : "configView.backups.disconnected",
                    )}
                  />
                )
              }
            >
              {(status) => (
                <>
                  {status.targets.length ? (
                    <For each={status.targets}>{(target) => renderTarget(target, status)}</For>
                  ) : (
                    <SettingsEmpty
                      message={
                        <>
                          {t("configView.backups.empty")}{" "}
                          <code>openclaw backup enable --to &lt;location&gt;</code>
                        </>
                      }
                    />
                  )}
                  <For each={unscheduled(status)}>
                    {(schedule) => (
                      <SettingsRow
                        title={schedule.target}
                        description={[
                          t("configView.backups.notRecorded"),
                          schedule.namespace === undefined
                            ? undefined
                            : t("configView.backups.namespace", { name: schedule.namespace! }),
                          schedule.nextRunAtMs === undefined
                            ? undefined
                            : nextRun(schedule.nextRunAtMs!),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        control={
                          <SettingsStatus kind="muted" label={t("configView.backups.scheduled")} />
                        }
                      />
                    )}
                  </For>
                </>
              )}
            </Show>
          </Loading>
        </Errored>
      </SettingsSection>
      <Show when={locations().length > 0}>
        <SettingsSection title={t("configView.backups.locations")}>
          <For each={locations()} keyed={(location) => location.name}>
            {(location) => {
              const checked = () => probeFor(location().name);
              const busy = () => probing().has(location().name);
              return (
                <SettingsRow
                  title={location().name}
                  description={[
                    location().displayTarget ?? location().provider,
                    checked()?.message,
                    checked()?.freeBytes === undefined
                      ? undefined
                      : t("configView.backups.free", {
                          size: formatByteSize(checked()!.freeBytes!, byteFormat),
                        }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  control={
                    <>
                      {checked() ? (
                        <span role="status">
                          <SettingsStatus
                            kind={checked()!.state === "ok" ? "ok" : "danger"}
                            label={t("configView.backups.probe." + checked()!.state)}
                          />
                        </span>
                      ) : undefined}
                      <button
                        class="btn"
                        disabled={busy() || !client()}
                        aria-label={t("configView.backups.checkLocation", {
                          name: location().name,
                        })}
                        onClick={() => void probe(location().name)}
                      >
                        {t(busy() ? "configView.backups.checking" : "configView.backups.check")}
                      </button>
                    </>
                  }
                />
              );
            }}
          </For>
        </SettingsSection>
      </Show>
    </>
  );
}
