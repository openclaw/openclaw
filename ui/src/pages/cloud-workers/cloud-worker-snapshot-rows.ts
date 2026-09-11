import { html, nothing } from "lit";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import { renderSettingsRow, renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationHuman, formatRelativeTimestamp } from "../../lib/format.ts";

export type SnapshotImage = {
  profileKey: string;
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  projectKey?: string;
  projectLabel?: string;
  projectRoot?: string;
  checkpointId?: string;
  state: "pending" | "available" | "no-image";
  createdAtMs?: number;
  lastDemandAtMs?: number | null;
  baseCommit?: string;
  runtimeIdentity?: { nodeBootstrapSha256: string };
  pinned?: { atMs: number };
  previous?: {
    checkpointId: string;
    createdAtMs: number;
    baseCommit?: string;
    runtimeIdentity?: { nodeBootstrapSha256: string };
    pinned?: { atMs: number };
  };
  held: boolean;
  allocationCount: number;
  retirement?: { checkpointId: string };
  capture?: {
    selector: string;
    leaseId?: string;
    phase: "scrubbing" | "creating" | "uncertain";
    stale: boolean;
  };
};
export type SnapshotProfile = {
  id: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  warmImages: "on" | "off";
  reason: string;
};
export type SnapshotsResult = {
  images: SnapshotImage[];
  profiles: SnapshotProfile[];
  legacyLeases: { leaseId: string; selector: string; recoveryHint: string }[];
};

type SnapshotRowOptions = {
  showMachineFacts: boolean;
  busy: boolean;
  buildBusy: boolean;
  deleteReason: string | null;
  onPin?: (previous: boolean) => void;
  onRollback?: () => void;
  onDelete?: () => void;
  onRecover?: () => void;
  onRebuild?: () => void;
};

function renderPin(image: SnapshotImage, options: SnapshotRowOptions, previous = false) {
  const checkpoint = previous ? image.previous : image;
  if (!checkpoint?.checkpointId || !options.onPin) {
    return nothing;
  }
  const reason =
    image.capture || image.retirement ? t("cloudWorkersPage.snapshots.captureOrRetirement") : "";
  return html`<button
    class="btn btn--sm"
    type="button"
    title=${reason}
    ?disabled=${Boolean(reason) || options.busy}
    @click=${() => options.onPin?.(previous)}
  >
    ${t(checkpoint.pinned ? "cloudWorkersPage.snapshots.unpin" : "cloudWorkersPage.snapshots.pin")}
  </button>`;
}

export function renderSnapshotImage(image: SnapshotImage, options: SnapshotRowOptions) {
  const phase = image.capture?.phase;
  const retiringCurrentImage = Boolean(
    image.retirement && image.retirement.checkpointId === image.checkpointId,
  );
  const imageState =
    phase ??
    (retiringCurrentImage ? "retiring" : image.state === "no-image" ? "noImage" : image.state);
  const runtimeDigest = image.runtimeIdentity?.nodeBootstrapSha256.slice(0, 12);
  const facts = [
    ...(options.showMachineFacts ? [image.backend, image.machineClass, image.os] : []),
    ...(image.baseCommit
      ? [t("cloudWorkersPage.snapshots.baseCommit", { commit: image.baseCommit.slice(0, 8) })]
      : []),
    ...(image.createdAtMs != null
      ? [
          t("cloudWorkersPage.snapshots.created", {
            age: formatRelativeTimestamp(image.createdAtMs),
          }),
        ]
      : []),
    ...(image.lastDemandAtMs != null
      ? [
          t("cloudWorkersPage.snapshots.lastUsed", {
            age: formatRelativeTimestamp(image.lastDemandAtMs),
          }),
        ]
      : []),
    t("cloudWorkersPage.snapshots.allocations", { count: String(image.allocationCount) }),
    ...(runtimeDigest ? [t("cloudWorkersPage.snapshots.runtime", { digest: runtimeDigest })] : []),
  ];
  return renderSettingsRow({
    title: image.projectKey
      ? (image.projectLabel ?? t("cloudWorkersPage.snapshots.projectImage"))
      : t("cloudWorkersPage.snapshots.machineImage"),
    description: html`
      ${facts.filter(Boolean).join(" · ")}
      ${
        image.previous
          ? html`<div>
              ${t("cloudWorkersPage.snapshots.previous")}:
              <code>${image.previous.checkpointId}</code>
              ${t("cloudWorkersPage.snapshots.created", { age: formatRelativeTimestamp(image.previous.createdAtMs) })}
              ${image.previous.baseCommit ? t("cloudWorkersPage.snapshots.baseCommit", { commit: image.previous.baseCommit.slice(0, 8) }) : nothing}
              ${image.previous.pinned ? renderSettingsStatus({ kind: "accent", label: t("cloudWorkersPage.snapshots.pinned") }) : nothing}
              ${renderPin(image, options, true)}
              ${
                options.onRollback
                  ? html`<button
                      class="btn btn--sm"
                      type="button"
                      title=${image.capture || image.retirement ? t("cloudWorkersPage.snapshots.captureOrRetirement") : ""}
                      ?disabled=${Boolean(image.capture || image.retirement) || options.busy}
                      @click=${options.onRollback}
                    >
                      ${t("cloudWorkersPage.snapshots.rollback")}
                    </button>`
                  : nothing
              }
            </div>`
          : nothing
      }
      ${
        image.retirement
          ? html`<br />${t("cloudWorkersPage.snapshots.retirementHint", {
                checkpoint: image.retirement.checkpointId,
              })}`
          : nothing
      }
    `,
    stackedOnNarrow: true,
    control: html`
      ${renderSettingsStatus({
        kind:
          phase === "uncertain" || retiringCurrentImage
            ? "warn"
            : phase
              ? "accent"
              : image.state === "available"
                ? "ok"
                : "muted",
        label: t(`cloudWorkersPage.snapshots.${imageState}`),
      })}
      ${image.pinned ? renderSettingsStatus({ kind: "accent", label: t("cloudWorkersPage.snapshots.pinned") }) : nothing}
      ${renderPin(image, options)}
      ${
        image.checkpointId && options.onDelete
          ? html`<button
              class="btn btn--sm danger"
              type="button"
              title=${options.deleteReason ?? ""}
              ?disabled=${Boolean(options.deleteReason) || options.busy}
              @click=${options.onDelete}
            >
              ${t("cloudWorkersPage.snapshots.delete")}
            </button>`
          : nothing
      }
      ${
        image.retirement
          ? renderSettingsStatus({
              kind: "warn",
              label: t("cloudWorkersPage.snapshots.retirementPending"),
            })
          : nothing
      }
      ${
        options.onRebuild
          ? html`<button
              class="btn btn--sm"
              type="button"
              ?disabled=${options.buildBusy}
              @click=${options.onRebuild}
            >
              ${t("cloudWorkersPage.snapshots.rebuild")}
            </button>`
          : nothing
      }
      ${
        phase === "uncertain" && options.onRecover
          ? html`
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${options.busy}
                @click=${options.onRecover}
              >
                ${t("cloudWorkersPage.snapshots.recover")}
              </button>
            `
          : nothing
      }
    `,
  });
}

export function renderSnapshotBuildRow(
  environment: EnvironmentSummary,
  cancelling: boolean,
  onCancel?: () => void,
) {
  const worker = environment.worker;
  if (!worker) {
    return nothing;
  }
  const failed = worker.state === "failed" || worker.state === "orphaned";
  return renderSettingsRow({
    title: t(
      failed
        ? `cloudWorkersPage.snapshots.buildStates.${worker.state}`
        : "cloudWorkersPage.snapshots.building",
    ),
    description: html`${environment.id} ·
    ${t(`cloudWorkersPage.snapshots.buildStates.${worker.state}`)} ·
    ${t("cloudWorkersPage.snapshots.buildAge", { age: formatDurationHuman(worker.ageMs) })}
    ${failed && worker.error ? html`<div class="callout warning" role="alert">${worker.error}</div>` : nothing}`,
    control:
      onCancel && !failed
        ? html`<button class="btn btn--sm" type="button" ?disabled=${cancelling} @click=${onCancel}>
            ${t("common.cancel")}
          </button>`
        : nothing,
  });
}
