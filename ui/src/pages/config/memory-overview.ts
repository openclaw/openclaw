import { html, nothing } from "lit";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";
import { lobsterPetSeed } from "../../components/lobster-pet-contract.ts";
import {
  createLobsterPetLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import {
  renderSettingsNavRow,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import "../../styles/memory-overview.css";
import type { MemoryEngineSelection } from "./memory-schema.ts";
import { selectedEngineId } from "./memory-schema.ts";

registerSettingsEnglish();

export type MemoryOverviewStatus =
  | { kind: "idle" | "loading" }
  | { kind: "ready"; payload: DoctorMemoryStatusPayload }
  | { kind: "error"; message: string };

type MemoryOverviewProps = {
  agentId: string | null;
  engineSelection: MemoryEngineSelection;
  engineDisabled: boolean;
  status: MemoryOverviewStatus;
  probingEmbeddings: boolean;
  onRefresh: () => void;
  onProbeEmbeddings: () => void;
  onNavigate: (tab: "memories" | "dreams" | "settings") => void;
};

type DreamingStatus = NonNullable<DoctorMemoryStatusPayload["dreaming"]>;
type DreamingPhase = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
};

function hasEmbeddingError(payload: DoctorMemoryStatusPayload): boolean {
  return !payload.embedding.ok && payload.embedding.checked !== false;
}

// Nothing owns the memory slot: it is switched off, plugins are disabled, or the configured
// owner is denied, disabled, or does not declare kind:"memory". Memory really is not running.
function isUnconfigured(payload: DoctorMemoryStatusPayload): boolean {
  return !payload.eligible;
}

// The owner is configured but its own load failed. The loader records that on the plugin record
// and rolls back its contributions instead of throwing, so this payload is otherwise identical to
// a clean owner that registered nothing. It is a real failure and must keep the failure hero and
// the engine-health card; letting it fall through to the neutral states below would hide it.
function hasFailedOwnerLoad(payload: DoctorMemoryStatusPayload): boolean {
  return payload.eligible && payload.ownerLoadFailed;
}

// A plugin DOES own the slot, loaded cleanly, and never registered a host memory capability.
// `plugins.slots.memory` names an owner; it does not promise a host capability. Plugins that
// implement recall and retain through registerAgentHooks() land here, and their memory is
// running - only the host-side integrations are absent. Reporting this as "not configured" or
// as a health failure are both false statements about a working system.
function isSelfManaged(payload: DoctorMemoryStatusPayload): boolean {
  return payload.eligible && !hasFailedOwnerLoad(payload) && !payload.capabilityRegistered;
}

// A plugin owns the slot and DID register a host memory capability; that capability simply
// declares no search runtime. `MemoryPluginCapability.runtime` is optional, so a prompt builder
// or public-artifact provider is a complete registration whose consumers keep working. Only host
// memory search is absent, so this must not reuse the self-managed copy, which enumerates every
// host integration as inactive.
function hasNoSearchRuntime(payload: DoctorMemoryStatusPayload): boolean {
  return (
    payload.eligible &&
    !hasFailedOwnerLoad(payload) &&
    payload.capabilityRegistered &&
    !payload.searchRuntimeRegistered
  );
}

// None of these states has a manager to probe, so all of them always carry embedding.ok: false.
// All must win over the embedding-error branch, and all must suppress the engine-health card, or
// the page renders a health failure underneath a non-failure verdict for the same payload.
// A failed owner load is deliberately excluded: that one IS a failure and keeps both.
function hasNoHostCapability(payload: DoctorMemoryStatusPayload): boolean {
  return isUnconfigured(payload) || isSelfManaged(payload) || hasNoSearchRuntime(payload);
}

function searchMode(payload: DoctorMemoryStatusPayload): string {
  return payload.provider === "none"
    ? t("memoryPage.overview.hero.keywordSearch")
    : t("memoryPage.overview.hero.hybridSearch");
}

function renderHero(props: MemoryOverviewProps) {
  const engineId = selectedEngineId(props.engineSelection);
  const off = props.engineSelection.kind === "off" || props.engineDisabled;
  const readyPayload = props.status.kind === "ready" ? props.status.payload : null;
  // Both no-capability states must win over hasEmbeddingError below (neither has a manager to
  // probe, so both always present with embedding.ok: false).
  const unconfigured = readyPayload !== null && isUnconfigured(readyPayload);
  const selfManaged = readyPayload !== null && isSelfManaged(readyPayload);
  const noSearchRuntime = readyPayload !== null && hasNoSearchRuntime(readyPayload);
  // A failed owner load is not subtracted here, so it reaches the error branch and keeps the
  // health-failure presentation the base page gave it.
  const error =
    !unconfigured &&
    !selfManaged &&
    !noSearchRuntime &&
    (props.status.kind === "error" || (readyPayload !== null && hasEmbeddingError(readyPayload)));
  const look = createLobsterPetLook(lobsterPetSeed(props.agentId ?? "memory"));
  const engineName = engineId ?? t("common.unknown");
  const headline = off
    ? t("memoryPage.overview.hero.hibernating")
    : props.status.kind === "loading" || props.status.kind === "idle"
      ? t("memoryPage.overview.hero.waking")
      : unconfigured
        ? t("memoryPage.overview.hero.unconfigured")
        : selfManaged
          ? t("memoryPage.overview.hero.selfManaged", { engine: engineName })
          : noSearchRuntime
            ? t("memoryPage.overview.hero.noSearchRuntime", { engine: engineName })
            : error
              ? t("memoryPage.overview.hero.needsAttention")
              : t("memoryPage.overview.hero.awake");
  const description = off
    ? t(
        props.engineDisabled
          ? "memoryPage.overview.hero.disabledDescription"
          : "memoryPage.overview.hero.offDescription",
      )
    : props.status.kind === "error"
      ? props.status.message
      : readyPayload
        ? unconfigured
          ? t("memoryPage.overview.hero.unconfiguredDescription")
          : selfManaged
            ? t("memoryPage.overview.hero.selfManagedDescription", { engine: engineName })
            : noSearchRuntime
              ? t("memoryPage.overview.hero.noSearchRuntimeDescription", { engine: engineName })
              : hasEmbeddingError(readyPayload)
                ? (readyPayload.embedding.error ?? t("memoryPage.overview.health.unavailable"))
                : t("memoryPage.overview.hero.activeDescription", {
                    engine: engineName,
                    mode: searchMode(readyPayload),
                  })
        : t("memoryPage.overview.hero.loadingDescription");
  // Self-managed memory and a registered capability without search are both running, so neither
  // is grumpy (a failure) nor sleeping (inert).
  const pose = off
    ? { sleeping: true }
    : error
      ? { grumpy: true, standalone: true }
      : selfManaged || noSearchRuntime
        ? { standalone: true }
        : readyPayload && !unconfigured
          ? { reading: true, standalone: true }
          : readyPayload
            ? { sleeping: true, standalone: true }
            : { standalone: true };

  return html`
    <section class="memory-overview__hero ${off ? "memory-overview__hero--sleeping" : ""}">
      <div class="memory-overview__lobster" style=${lobsterLookStyle(look)}>
        ${renderLobsterSvg(look, pose)}
      </div>
      <div class="memory-overview__hero-copy">
        <h2>${headline}</h2>
        <p class=${error ? "memory-overview__hero-error" : ""}>${description}</p>
        <div class="memory-overview__hero-actions">
          ${
            off
              ? html`<button class="btn btn--sm" @click=${() => props.onNavigate("settings")}>
                  ${t("memoryPage.overview.hero.openSettings")}
                </button>`
              : html`<button class="btn btn--sm" @click=${props.onRefresh}>
                  ${
                    props.status.kind === "error"
                      ? t("memoryPage.overview.hero.retry")
                      : t("memoryPage.overview.hero.refresh")
                  }
                </button>`
          }
        </div>
      </div>
    </section>
  `;
}

function phaseScheduleDescription(
  phase: DreamingPhase,
  timezone: string | undefined,
  scheduled: boolean,
) {
  const details = [
    phase.cron || t("common.na"),
    timezone,
    scheduled && phase.nextRunAtMs
      ? t("memoryPage.overview.schedule.nextRun", {
          time: formatRelativeTimestamp(phase.nextRunAtMs),
        })
      : null,
    phase.lastRunAtMs
      ? t("memoryPage.overview.schedule.lastRun", {
          time: formatRelativeTimestamp(phase.lastRunAtMs),
        })
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  return details.join(" · ");
}

function renderSchedule(dreaming: DreamingStatus) {
  const phases = [
    ["light", dreaming.phases.light],
    ["rem", dreaming.phases.rem],
    ["deep", dreaming.phases.deep],
  ] as const;
  return renderSettingsSection(
    { title: t("memoryPage.overview.schedule.title") },
    html`
      ${phases.map(([name, phase]) =>
        renderSettingsRow({
          title: t(`memoryPage.dreaming.phases.${name}.title`),
          description: html`
            ${t(`memoryPage.overview.schedule.${name}Description`)}<br />
            ${phaseScheduleDescription(
              phase,
              dreaming.timezone,
              dreaming.enabled && phase.enabled && phase.managedCronPresent,
            )}
          `,
          control: renderSettingsStatus({
            kind: dreaming.enabled && phase.enabled && phase.managedCronPresent ? "ok" : "muted",
            label:
              !dreaming.enabled || !phase.enabled
                ? t("common.disabled")
                : phase.managedCronPresent
                  ? t("common.enabled")
                  : t("memoryPage.overview.schedule.notScheduled"),
          }),
        }),
      )}
      ${renderSettingsRow({
        title: t("memoryPage.overview.schedule.learnMore"),
        control: html`<a
          class="memory-page__link"
          href="https://docs.openclaw.ai/concepts/dreaming"
          target="_blank"
          rel="noreferrer noopener"
          >${t("memoryPage.overview.schedule.openDocs")}</a
        >`,
      })}
    `,
  );
}

function renderActivity(dreaming: DreamingStatus) {
  const rows = [
    ["promotedToday", dreaming.promotedToday],
    ["promotedTotal", dreaming.promotedTotal],
    ["shortTermCount", dreaming.shortTermCount],
    ["phaseHitCount", dreaming.phaseSignalCount],
    ["lightPhaseHitCount", dreaming.lightPhaseHitCount],
    ["remPhaseHitCount", dreaming.remPhaseHitCount],
  ] as const;
  return renderSettingsSection(
    { title: t("memoryPage.overview.activity.title") },
    rows.map(([label, value]) =>
      renderSettingsRow({
        title: t(`memoryPage.overview.activity.${label}`),
        control: renderSettingsValue(value),
      }),
    ),
  );
}

function renderEngineHealth(payload: DoctorMemoryStatusPayload, props: MemoryOverviewProps) {
  const notChecked = payload.embedding.checked === false;
  const embeddingKind = payload.embedding.ok ? "ok" : notChecked ? "muted" : "danger";
  const embeddingLabel = props.probingEmbeddings
    ? t("memoryPage.overview.health.checking")
    : payload.embedding.ok
      ? t("memoryPage.overview.health.healthy")
      : notChecked
        ? t("memoryPage.overview.health.notChecked")
        : t("memoryPage.overview.health.unavailable");
  return renderSettingsSection(
    { title: t("memoryPage.overview.health.title") },
    html`
      ${renderSettingsRow({
        title: t("memoryPage.overview.health.provider"),
        control: renderSettingsValue(payload.provider ?? t("common.unknown"), { mono: true }),
      })}
      ${renderSettingsRow({
        title: t("memoryPage.overview.health.embeddings"),
        description: payload.embedding.ok
          ? nothing
          : notChecked
            ? t("memoryPage.overview.health.notCheckedDescription")
            : payload.embedding.error,
        control: html`
          ${renderSettingsStatus({ kind: embeddingKind, label: embeddingLabel })}
          ${
            notChecked
              ? html`<button
                  type="button"
                  class="btn btn--sm"
                  ?disabled=${props.probingEmbeddings}
                  @click=${props.onProbeEmbeddings}
                >
                  ${
                    props.probingEmbeddings
                      ? t("memoryPage.overview.health.testing")
                      : t("memoryPage.overview.health.test")
                  }
                </button>`
              : nothing
          }
        `,
      })}
      ${
        payload.embeddingRuntime
          ? renderSettingsRow({
              title: t("memoryPage.overview.health.runtime"),
              description: payload.embeddingRuntime.loadError,
              control: renderSettingsValue(
                [
                  payload.embeddingRuntime.engine,
                  payload.embeddingRuntime.backend,
                  payload.embeddingRuntime.buildInfo,
                  payload.embeddingRuntime.model?.id,
                  payload.embeddingRuntime.endpoints
                    ? Object.entries(payload.embeddingRuntime.endpoints)
                        .map(([name, state]) => `${name}=${state}`)
                        .join(" ")
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ),
            })
          : nothing
      }
    `,
  );
}

function renderStatusCards(props: MemoryOverviewProps) {
  if (props.status.kind !== "ready") {
    return nothing;
  }
  const payload = props.status.payload;
  return html`
    ${payload.dreaming ? renderSchedule(payload.dreaming) : nothing}
    ${payload.dreaming ? renderActivity(payload.dreaming) : nothing}
    ${hasNoHostCapability(payload) ? nothing : renderEngineHealth(payload, props)}
  `;
}

function renderShortcuts(props: MemoryOverviewProps) {
  return renderSettingsSection(
    { title: t("memoryPage.overview.shortcuts.title") },
    html`
      ${renderSettingsNavRow({
        title: t("memoryPage.overview.shortcuts.memories"),
        onClick: () => props.onNavigate("memories"),
      })}
      ${renderSettingsNavRow({
        title: t("memoryPage.overview.shortcuts.diary"),
        onClick: () => props.onNavigate("dreams"),
      })}
      ${renderSettingsNavRow({
        title: t("memoryPage.overview.shortcuts.settings"),
        onClick: () => props.onNavigate("settings"),
      })}
    `,
  );
}

export function renderMemoryOverview(props: MemoryOverviewProps) {
  const active = props.engineSelection.kind !== "off" && !props.engineDisabled;
  return html`
    <div class="settings-page memory-overview">
      ${renderHero(props)} ${active ? renderStatusCards(props) : nothing} ${renderShortcuts(props)}
    </div>
  `;
}
