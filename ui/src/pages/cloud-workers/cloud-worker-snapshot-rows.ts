import { html, nothing } from "lit";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import { renderSettingsRow, renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

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
  captureUnsupported?: { atMs: number; provider: string; message: string };
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

function renderImageAction(
  action: "pin" | "unpin" | "rollback" | "delete" | "rebuild" | "recover",
  target: string | undefined,
  onClick: (() => void) | undefined,
  disabled: boolean,
  title?: string,
) {
  const label = t(`cloudWorkersPage.snapshots.${action}`);
  return onClick
    ? html`<button
        class=${action === "delete" ? "btn btn--sm danger" : "btn btn--sm"}
        type="button"
        aria-label=${`${label}: ${target}`}
        title=${title ?? nothing}
        ?disabled=${disabled}
        @click=${onClick}
      >
        ${label}
      </button>`
    : nothing;
}

export function renderSnapshotImage(image: SnapshotImage, options: SnapshotRowOptions) {
  const changeReason =
    image.capture || image.retirement ? t("cloudWorkersPage.snapshots.captureOrRetirement") : "";
  const renderPin = (previous = false) => {
    const checkpoint = previous ? image.previous : image;
    return checkpoint?.checkpointId && options.onPin
      ? renderImageAction(
          checkpoint.pinned ? "unpin" : "pin",
          checkpoint.checkpointId,
          () => options.onPin?.(previous),
          Boolean(changeReason) || options.busy,
          changeReason,
        )
      : nothing;
  };
  const phase = image.capture?.phase;
  const retiringCurrentImage = Boolean(
    image.retirement && image.retirement.checkpointId === image.checkpointId,
  );
  const imageState =
    phase ??
    (retiringCurrentImage
      ? "retiring"
      : image.state === "no-image"
        ? image.captureUnsupported
          ? "coldOnly"
          : "noImage"
        : image.state);
  const runtimeDigest = image.runtimeIdentity?.nodeBootstrapSha256.slice(0, 12);
  const facts = [
    ...(options.showMachineFacts ? [image.backend, image.machineClass, image.os] : []),
    image.baseCommit &&
      t("cloudWorkersPage.snapshots.baseCommit", { commit: image.baseCommit.slice(0, 8) }),
    image.createdAtMs != null &&
      t("cloudWorkersPage.snapshots.created", {
        age: formatRelativeTimestamp(image.createdAtMs),
      }),
    image.lastDemandAtMs != null &&
      t("cloudWorkersPage.snapshots.lastUsed", {
        age: formatRelativeTimestamp(image.lastDemandAtMs),
      }),
    t("cloudWorkersPage.snapshots.allocations", { count: String(image.allocationCount) }),
    runtimeDigest && t("cloudWorkersPage.snapshots.runtime", { digest: runtimeDigest }),
  ];
  return renderSettingsRow({
    title: image.projectKey
      ? (image.projectLabel ?? t("cloudWorkersPage.snapshots.projectImage"))
      : t("cloudWorkersPage.snapshots.machineImage"),
    description: html`
      ${facts.filter(Boolean).join(" · ")}
      ${
        image.captureUnsupported
          ? html`<div>
              ${image.captureUnsupported.message.replace(/[.\s]+$/u, "")}.
              ${t("cloudWorkersPage.snapshots.captureUnsupportedHint")}
            </div>`
          : nothing
      }
      ${
        image.previous
          ? html`<div>
              ${t("cloudWorkersPage.snapshots.previous")}:
              <code>${image.previous.checkpointId}</code>
              ${t("cloudWorkersPage.snapshots.created", { age: formatRelativeTimestamp(image.previous.createdAtMs) })}
              ${image.previous.baseCommit ? t("cloudWorkersPage.snapshots.baseCommit", { commit: image.previous.baseCommit.slice(0, 8) }) : nothing}
              ${image.previous.pinned ? renderSettingsStatus({ kind: "accent", label: t("cloudWorkersPage.snapshots.pinned") }) : nothing}
              ${renderPin(true)}
              ${renderImageAction(
                "rollback",
                image.previous.checkpointId,
                options.onRollback,
                Boolean(image.capture || image.retirement) || options.busy,
                changeReason,
              )}
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
      ${renderPin()}
      ${renderImageAction(
        "delete",
        image.checkpointId,
        image.checkpointId ? options.onDelete : undefined,
        Boolean(options.deleteReason) || options.busy,
        options.deleteReason ?? "",
      )}
      ${
        image.retirement
          ? renderSettingsStatus({
              kind: "warn",
              label: t("cloudWorkersPage.snapshots.retirementPending"),
            })
          : nothing
      }
      ${renderImageAction(
        "rebuild",
        image.projectLabel ??
          image.projectRoot ??
          image.projectKey ??
          image.profileId ??
          image.profileKey,
        options.onRebuild,
        options.buildBusy,
      )}
      ${renderImageAction(
        "recover",
        image.capture?.selector,
        phase === "uncertain" ? options.onRecover : undefined,
        options.busy,
      )}
    `,
  });
}

export function renderSnapshotBuildRow(
  environment: EnvironmentSummary,
  options: { busy: boolean; onCancel?: () => void; onDismiss?: () => void },
) {
  const worker = environment.worker;
  if (!worker) {
    return nothing;
  }
  const failed = worker.state === "failed" || worker.state === "orphaned";
  const action = failed ? options.onDismiss : options.onCancel;
  const actionLabel = t(failed ? "cloudWorkersPage.snapshots.dismiss" : "common.cancel");
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
    control: action
      ? html`<button
          class="btn btn--sm"
          type="button"
          aria-label=${`${actionLabel}: ${environment.id}`}
          ?disabled=${options.busy}
          @click=${action}
        >
          ${actionLabel}
        </button>`
      : nothing,
  });
}
