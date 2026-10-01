import type { BackupStatusResult } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatByteSize, formatDateTimeMs, formatTimeAgo } from "../../lib/format.ts";
import type { SystemsController } from "./systems-controller.ts";

const byteFormat = {
  style: "legacy-binary",
  separator: " ",
  maxUnit: "tera",
  fractionDigits: 0,
} as const;

function matchesSchedule(
  target: BackupStatusResult["targets"][number],
  schedule: BackupStatusResult["schedules"][number],
) {
  return (
    schedule.enabled &&
    schedule.target === target.target &&
    (schedule.mode === "offsite"
      ? target.kind === "archive" && schedule.namespace === target.namespace
      : target.kind === "git")
  );
}

function renderTarget(target: BackupStatusResult["targets"][number], status: BackupStatusResult) {
  const { latest, latestOk } = target;
  const pushFailed = target.kind === "git" && latest.status === "ok" && latest.pushFailed === true;
  const failed = latest.status === "failed" || pushFailed;
  const storedLocation = latest.location ?? latestOk?.location;
  const location = status.locations.find(
    (entry) =>
      entry.name ===
      (storedLocation?.name ?? (target.kind === "archive" ? target.target : undefined)),
  );
  const schedules = status.schedules.filter((entry) => matchesSchedule(target, entry));
  const nextRunAtMs = schedules.reduce<number | undefined>(
    (next, entry) =>
      entry.nextRunAtMs === undefined ? next : Math.min(next ?? Infinity, entry.nextRunAtMs),
    undefined,
  );
  const size = latestOk?.location?.storedBytes ?? latestOk?.bytes;
  return html`<li class="systems-backup" data-status=${failed ? "failed" : "ok"}>
    <div class="systems-backup__heading">
      <strong>${storedLocation?.name ?? target.target}</strong>
      <span class="systems-backup__state"
        >${t(pushFailed ? "systems.backups.pushFailed" : failed ? "systems.backups.failed" : "systems.backups.ok")}</span
      >
    </div>
    <div class="systems-backup__meta">
      <span>${t("systems.backups.kinds." + target.kind)}</span>
      <span
        >${t(pushFailed ? "systems.backups.lastLocalSuccess" : "systems.backups.lastSuccess", { age: latestOk ? formatTimeAgo(Math.max(0, Date.now() - latestOk.createdAt)) : t("systems.backups.never") })}</span
      >
      ${size === undefined ? nothing : html`<span>${formatByteSize(size, byteFormat)}</span>`}
      ${nextRunAtMs === undefined ? nothing : html`<span>${t("systems.backups.nextRun", { time: formatDateTimeMs(nextRunAtMs, { dateStyle: "short", timeStyle: "short" }) })}</span>`}
    </div>
    <div class="systems-backup__destination">${location?.displayTarget ?? target.target}</div>
    ${target.namespace === undefined ? nothing : html`<div class="systems-backup__meta">${t("systems.backups.namespace", { name: target.namespace })}</div>`}
    ${failed ? html`<p class="systems-backup__error">${latest.error ?? t(pushFailed ? "systems.backups.pushFailureHint" : "systems.backups.failureHint")}</p>` : nothing}
  </li>`;
}

export function renderSystemsBackups(controller: SystemsController) {
  const status = controller.backups;
  return html`<section
    class="systems-backups"
    aria-label=${t("systems.backups.title")}
    aria-busy=${controller.backupsLoading}
  >
    <h2>${t("systems.backups.title")}</h2>
    ${
      controller.backupsError
        ? html`<p class="systems-backup__error" role="alert">
            ${controller.backupsError}
            <button
              class="systems-backups__check"
              ?disabled=${controller.backupsLoading || !controller.connected}
              @click=${() => void controller.refreshBackups()}
            >
              ${t("common.retry")}
            </button>
          </p>`
        : nothing
    }
    ${!status && !controller.backupsError ? html`<p class="systems-backups__hint" role="status">${t(controller.connected ? "systems.backups.loading" : "systems.offlineGateway")}</p>` : nothing}
    ${
      status
        ? html`
            ${
              status.targets.length
                ? html`<ul class="systems-backups__targets">
                    ${status.targets.map((target) => renderTarget(target, status))}
                  </ul>`
                : html`<p class="systems-backups__hint">
                    ${t("systems.backups.empty")}
                    <code>openclaw backup enable --to &lt;location&gt;</code>
                  </p>`
            }
            ${status.schedules.filter((schedule) => schedule.enabled && !status.targets.some((target) => matchesSchedule(target, schedule))).map((schedule) => html`<p class="systems-backups__hint">${t("systems.backups.scheduled", { target: schedule.target })} ${schedule.namespace === undefined ? nothing : t("systems.backups.namespace", { name: schedule.namespace })} ${schedule.nextRunAtMs === undefined ? nothing : t("systems.backups.nextRun", { time: formatDateTimeMs(schedule.nextRunAtMs, { dateStyle: "short", timeStyle: "short" }) })}</p>`)}
            ${
              status.locations.length
                ? html`<h3>${t("systems.backups.locations")}</h3>
                    <ul class="systems-backups__locations">
                      ${status.locations.map((location) => {
                        const probe = controller.storageProbes.get(location.name);
                        const busy = controller.storageProbeBusy(location.name);
                        return html`<li class="systems-storage-location">
                          <div>
                            <strong>${location.name}</strong
                            ><span class="systems-backup__destination"
                              >${location.displayTarget ?? location.provider}</span
                            >
                          </div>
                          <button
                            class="systems-backups__check"
                            ?disabled=${busy || !controller.connected}
                            aria-label=${t("systems.backups.checkLocation", { name: location.name })}
                            @click=${() => void controller.probeStorage(location.name)}
                          >
                            ${t(busy ? "systems.backups.checking" : "systems.backups.check")}
                          </button>
                          ${probe ? html`<p class=${probe.state === "ok" ? "systems-backups__hint" : "systems-backup__error"} role="status">${t("systems.backups.probe." + probe.state)}${probe.message ? ` · ${probe.message}` : nothing}${probe.freeBytes === undefined ? nothing : ` · ${t("systems.backups.free", { size: formatByteSize(probe.freeBytes, byteFormat) })}`}</p>` : nothing}
                        </li>`;
                      })}
                    </ul>`
                : nothing
            }
          `
        : nothing
    }
  </section>`;
}
