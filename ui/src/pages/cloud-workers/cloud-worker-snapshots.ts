import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsSummary,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { showToast } from "../../lib/toast.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "./cloud-worker-snapshot-policy.ts";

registerSettingsEnglish();

type SnapshotImage = {
  profileKey: string;
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  projectKey?: string;
  projectLabel?: string;
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
    phase: "scrubbing" | "creating" | "uncertain";
    stale: boolean;
  };
};
type SnapshotProfile = {
  id: string;
  backend?: string;
  machineClass?: string;
  os?: string;
  warmImages: "on" | "off";
  reason: string;
};
type SnapshotsResult = {
  images: SnapshotImage[];
  profiles: SnapshotProfile[];
  legacyLeases: { leaseId: string; selector: string; recoveryHint: string }[];
};

class CloudWorkerSnapshots extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private result: SnapshotsResult | null = null;
  @state() private loading = false;
  @state() private mutating: string | null = null;
  @state() private recovering: string | null = null;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  private confirmation: AbortController | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.result = null;
      this.loading = false;
      this.recovering = null;
      this.mutating = null;
      this.error = null;
      this.notice = null;
      this.confirmation?.abort();
    },
    ensureInitialData: () => void this.load(),
  });

  private canCall(method: string) {
    return canCallGatewayMethod(this.gateway.snapshot, method, "operator.admin");
  }

  private async load() {
    const scope = this.gateway.capture();
    if (!scope || this.loading || !this.canCall("crabbox.images.list")) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = await scope.client.request<SnapshotsResult>("crabbox.images.list", {});
      if (this.gateway.isCurrent(scope)) {
        this.result = result;
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.loading = false;
      }
    }
  }

  private async recover(image: SnapshotImage) {
    const scope = this.gateway.capture();
    const selector = image.capture?.selector;
    if (
      !scope ||
      !selector ||
      image.capture?.phase !== "uncertain" ||
      this.recovering ||
      this.mutating ||
      !this.canCall("crabbox.images.recover")
    ) {
      return;
    }
    const confirmation = new AbortController();
    this.confirmation = confirmation;
    const confirmed = await showConfirmDialog({
      title: t("cloudWorkersPage.snapshots.recoverTitle"),
      message: t("cloudWorkersPage.snapshots.recoverMessage"),
      details: selector,
      confirmLabel: t("cloudWorkersPage.snapshots.recover"),
      requiredAcknowledgement: t("cloudWorkersPage.snapshots.acknowledgement"),
      signal: confirmation.signal,
    });
    if (this.confirmation === confirmation) {
      this.confirmation = null;
    }
    if (!confirmed) {
      return;
    }
    if (!this.gateway.isCurrent(scope) || !this.canCall("crabbox.images.recover")) {
      this.error = t("cloudWorkersPage.snapshots.recoveryChanged");
      return;
    }
    this.recovering = selector;
    this.error = null;
    this.notice = null;
    try {
      await scope.client.request("crabbox.images.recover", {
        selector,
        acknowledgeProviderCleanup: true,
      });
      if (this.gateway.isCurrent(scope)) {
        this.notice = t("cloudWorkersPage.snapshots.recovered");
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.recovering = null;
      }
    }
  }

  private deleteReason(image: SnapshotImage) {
    return image.pinned
      ? t("cloudWorkersPage.snapshots.deletePinned")
      : image.held
        ? t("cloudWorkersPage.snapshots.deleteHeld")
        : image.capture
          ? t("cloudWorkersPage.snapshots.deleteCapturing")
          : null;
  }

  private async mutateImage(
    image: SnapshotImage,
    action: "pin" | "delete" | "rollback",
    previous = false,
  ) {
    const scope = this.gateway.capture();
    const checkpoint = previous ? image.previous : image;
    const checkpointId = checkpoint?.checkpointId;
    const method = `crabbox.images.${action}`;
    if (
      !scope ||
      !checkpoint ||
      !checkpointId ||
      this.mutating ||
      this.recovering ||
      this.loading ||
      !this.canCall(method)
    ) {
      return;
    }
    if (
      (action === "delete" && this.deleteReason(image)) ||
      (action !== "delete" && (image.capture || image.retirement))
    ) {
      return;
    }
    this.mutating = checkpointId;
    try {
      if (action !== "pin") {
        const confirmation = new AbortController();
        this.confirmation = confirmation;
        const confirmed = await showConfirmDialog({
          title: t(`cloudWorkersPage.snapshots.${action}Title`),
          message: t(`cloudWorkersPage.snapshots.${action}Message`),
          details: checkpointId,
          confirmLabel: t(`cloudWorkersPage.snapshots.${action}`),
          danger: action === "delete",
          signal: confirmation.signal,
        });
        if (this.confirmation === confirmation) {
          this.confirmation = null;
        }
        if (!confirmed) {
          return;
        }
      }
      if (!this.gateway.isCurrent(scope) || !this.canCall(method)) {
        return;
      }
      let notice: string | null = null;
      if (action === "delete") {
        const result = await scope.client.request<{ status: "deleted" | "retiring" }>(method, {
          checkpointId,
        });
        if (result.status === "retiring") {
          notice = t("cloudWorkersPage.snapshots.deletionRetiring");
        }
      } else {
        await scope.client.request<SnapshotImage>(method, {
          checkpointId,
          ...(action === "pin" ? { pinned: !checkpoint.pinned } : {}),
        });
      }
      if (this.gateway.isCurrent(scope)) {
        this.notice = notice;
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        showToast({ message: formatUiError(error) });
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.mutating = null;
      }
    }
  }

  private renderPin(image: SnapshotImage, previous = false) {
    const checkpoint = previous ? image.previous : image;
    if (!checkpoint?.checkpointId || !this.canCall("crabbox.images.pin")) {
      return nothing;
    }
    const reason =
      image.capture || image.retirement ? t("cloudWorkersPage.snapshots.captureOrRetirement") : "";
    return html`<button
      class="btn btn--sm"
      type="button"
      title=${reason}
      ?disabled=${Boolean(reason) || this.mutating !== null || this.recovering !== null || this.loading}
      @click=${() => void this.mutateImage(image, "pin", previous)}
    >
      ${t(checkpoint.pinned ? "cloudWorkersPage.snapshots.unpin" : "cloudWorkersPage.snapshots.pin")}
    </button>`;
  }

  private renderImage(image: SnapshotImage, showMachineFacts: boolean) {
    const phase = image.capture?.phase;
    const retiringCurrentImage = Boolean(
      image.retirement && image.retirement.checkpointId === image.checkpointId,
    );
    const imageState =
      phase ??
      (retiringCurrentImage ? "retiring" : image.state === "no-image" ? "noImage" : image.state);
    const runtimeDigest = image.runtimeIdentity?.nodeBootstrapSha256.slice(0, 12);
    const facts = [
      ...(showMachineFacts ? [image.backend, image.machineClass, image.os] : []),
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
      ...(runtimeDigest
        ? [t("cloudWorkersPage.snapshots.runtime", { digest: runtimeDigest })]
        : []),
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
                ${this.renderPin(image, true)}
                ${
                  this.canCall("crabbox.images.rollback")
                    ? html`<button
                        class="btn btn--sm"
                        type="button"
                        title=${image.capture || image.retirement ? t("cloudWorkersPage.snapshots.captureOrRetirement") : ""}
                        ?disabled=${Boolean(image.capture || image.retirement) || this.mutating !== null || this.recovering !== null || this.loading}
                        @click=${() => void this.mutateImage(image, "rollback", true)}
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
        ${this.renderPin(image)}
        ${
          image.checkpointId && this.canCall("crabbox.images.delete")
            ? html`<button
                class="btn btn--sm danger"
                type="button"
                title=${this.deleteReason(image) ?? ""}
                ?disabled=${Boolean(this.deleteReason(image)) || this.mutating !== null || this.recovering !== null || this.loading}
                @click=${() => void this.mutateImage(image, "delete")}
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
          phase === "uncertain" && this.canCall("crabbox.images.recover")
            ? html`
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${this.recovering !== null || this.mutating !== null || this.loading}
                  @click=${() => void this.recover(image)}
                >
                  ${t("cloudWorkersPage.snapshots.recover")}
                </button>
              `
            : nothing
        }
      `,
    });
  }

  private renderImages(result: SnapshotsResult) {
    const groups = new Map<
      string | undefined,
      { profile?: SnapshotProfile; images: SnapshotImage[] }
    >(result.profiles.map((profile) => [profile.id, { profile, images: [] }]));
    for (const image of result.images) {
      const group = groups.get(image.profileId) ?? { images: [] };
      group.images.push(image);
      groups.set(image.profileId, group);
    }
    return html`
      ${renderSettingsSummary([
        {
          label: t("cloudWorkersPage.snapshots.images"),
          value: result.images.filter((image) => image.checkpointId).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.building"),
          value: result.images.filter(
            (image) => image.capture && image.capture.phase !== "uncertain",
          ).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.held"),
          value: result.images.filter((image) => image.held).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.attention"),
          value: result.images.filter(
            (image) =>
              image.retirement || image.capture?.phase === "uncertain" || image.capture?.stale,
          ).length,
        },
      ])}
      ${
        groups.size
          ? [...groups].map(([id, group]) => {
              const metadata = (["backend", "machineClass", "os"] as const).map((key) => {
                const values = Array.from(
                  new Set(group.images.map((image) => image[key]).filter(Boolean)),
                );
                const configured = group.profile?.[key];
                return values.length ? values : configured ? [configured] : [];
              });
              const facts = metadata.map((values) => values.join(", ")).filter(Boolean);
              const mixedMetadata = metadata.some((values) => values.length > 1);
              if (group.profile) {
                facts.push(
                  t(
                    group.profile.warmImages === "on"
                      ? "cloudWorkersPage.snapshots.warmOn"
                      : "cloudWorkersPage.snapshots.warmOff",
                  ),
                  group.profile.reason,
                );
              }
              return renderSettingsSection(
                {
                  title: id ?? t("cloudWorkersPage.snapshots.unlabeledProfile"),
                  description: facts.join(" · "),
                  count: group.images.length,
                },
                group.images.length
                  ? group.images.map((entry) => this.renderImage(entry, mixedMetadata))
                  : renderSettingsEmpty(t("cloudWorkersPage.snapshots.profileEmpty")),
              );
            })
          : renderSettingsEmpty(t("cloudWorkersPage.snapshots.empty"))
      }
      ${
        result.legacyLeases.length
          ? renderSettingsSection(
              {
                title: t("cloudWorkersPage.snapshots.migration"),
                description: t("cloudWorkersPage.snapshots.migrationHint"),
              },
              result.legacyLeases.map((lease) =>
                renderSettingsRow({ title: lease.leaseId, description: lease.recoveryHint }),
              ),
            )
          : nothing
      }
    `;
  }

  override render() {
    const advertised =
      isGatewayMethodAdvertised(this.gateway.snapshot ?? {}, "crabbox.images.list") === true;
    if (!advertised || !this.canCall("crabbox.images.list")) {
      return renderSettingsPage(
        renderSettingsEmpty(
          t(
            advertised
              ? "cloudWorkersPage.snapshots.adminRequired"
              : "cloudWorkersPage.snapshots.unavailable",
          ),
        ),
      );
    }
    return renderSettingsPage(html`
      ${renderSettingsSection(
        {},
        renderSettingsRow({
          title: t("cloudWorkersPage.snapshots.title"),
          control: html`<button
            class="btn btn--sm"
            type="button"
            ?disabled=${this.loading || this.recovering !== null || this.mutating !== null}
            @click=${() => void this.load()}
          >
            ${t("cloudWorkersPage.snapshots.refresh")}
          </button>`,
        }),
      )}
      ${this.error ? html`<div class="callout warning" role="alert">${this.error}</div>` : nothing}
      ${this.notice ? html`<div class="callout" role="status">${this.notice}</div>` : nothing}
      ${this.result ? this.renderImages(this.result) : this.loading ? renderSettingsEmpty(t("common.loading")) : nothing}
      <openclaw-cloud-worker-snapshot-policy></openclaw-cloud-worker-snapshot-policy>
    `);
  }
}

if (!customElements.get("openclaw-cloud-worker-snapshots")) {
  customElements.define("openclaw-cloud-worker-snapshots", CloudWorkerSnapshots);
}
