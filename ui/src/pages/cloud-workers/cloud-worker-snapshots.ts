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
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

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
                  ?disabled=${this.recovering !== null || this.loading}
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
            ?disabled=${this.loading || this.recovering !== null}
            @click=${() => void this.load()}
          >
            ${t("cloudWorkersPage.snapshots.refresh")}
          </button>`,
        }),
      )}
      ${this.error ? html`<div class="callout warning" role="alert">${this.error}</div>` : nothing}
      ${this.notice ? html`<div class="callout" role="status">${this.notice}</div>` : nothing}
      ${this.result ? this.renderImages(this.result) : this.loading ? renderSettingsEmpty(t("common.loading")) : nothing}
    `);
  }
}

if (!customElements.get("openclaw-cloud-worker-snapshots")) {
  customElements.define("openclaw-cloud-worker-snapshots", CloudWorkerSnapshots);
}
