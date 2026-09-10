import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  ProjectsListResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog, type ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSummary,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { showToast } from "../../lib/toast.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  renderSnapshotBuildRow,
  renderSnapshotImage,
  type SnapshotImage,
  type SnapshotProfile,
  type SnapshotsResult,
} from "./cloud-worker-snapshot-rows.ts";
import "./cloud-worker-snapshot-policy.ts";

registerSettingsEnglish();

class CloudWorkerSnapshots extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private result: SnapshotsResult | null = null;
  @state() private loading = false;
  @state() private mutating: string | null = null;
  @state() private recovering: string | null = null;
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private builds: EnvironmentSummary[] = [];
  @state() private failedBuilds: EnvironmentSummary[] = [];
  @state() private buildDialog = false;
  @state() private buildProfile = "";
  @state() private buildProject = "";
  @state() private repositories: { root: string; label: string }[] = [];
  @state() private repositoriesLoading = false;
  @state() private buildError: string | null = null;
  @state() private preparing = false;
  @state() private cancelling: string | null = null;
  private refreshAgain = false;
  private pickerGeneration = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmation: AbortController | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.refreshAgain = false;
      this.stopPolling();
      this.closeBuildDialog();
      this.builds = [];
      this.failedBuilds = [];
      this.preparing = false;
      this.cancelling = null;
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

  private async confirm(options: ConfirmDialogOptions) {
    const confirmation = new AbortController();
    this.confirmation = confirmation;
    const confirmed = await showConfirmDialog({ ...options, signal: confirmation.signal });
    if (this.confirmation === confirmation) {
      this.confirmation = null;
    }
    return confirmed;
  }

  private async load() {
    const scope = this.gateway.capture();
    if (this.loading) {
      this.refreshAgain = true;
      return;
    }
    if (!scope || !this.canCall("crabbox.images.list")) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const environments = await scope.client.request<EnvironmentsListResult>(
        "environments.list",
        {},
      );
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      const builds = environments.environments.filter(
        (environment) =>
          environment.preparation?.purpose === "build" &&
          environment.worker &&
          environment.worker.attachedSessionIds.length === 0,
      );
      this.builds = builds.filter(
        (environment) =>
          environment.worker &&
          ["requested", "provisioning", "bootstrapping"].includes(environment.worker.state),
      );
      this.failedBuilds = builds.filter(
        (environment) =>
          environment.worker && ["failed", "orphaned"].includes(environment.worker.state),
      );
      if (this.failedBuilds.length) {
        this.notice = null;
      }
      // Capture settles before worker readiness; read images after that readiness snapshot.
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
        this.stopPolling();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          void this.load();
        } else if (
          this.builds.length ||
          this.result?.images.some((image) => image.capture && image.capture.phase !== "uncertain")
        ) {
          this.pollTimer = setTimeout(() => void this.load(), 10_000);
        }
      }
    }
  }

  private stopPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private closeBuildDialog() {
    this.pickerGeneration += 1;
    this.buildDialog = false;
    this.repositories = [];
    this.repositoriesLoading = false;
    this.buildError = null;
  }

  private async openBuildDialog() {
    const scope = this.gateway.capture();
    if (!scope || !this.canCall("environments.prepare") || this.preparing) {
      return;
    }
    const generation = ++this.pickerGeneration;
    this.buildDialog = true;
    this.buildProfile = "";
    this.buildProject = "";
    this.buildError = null;
    this.repositories = [];
    this.repositoriesLoading = true;
    const current = () => this.gateway.isCurrent(scope) && generation === this.pickerGeneration;
    try {
      // Use the same Gateway-local catalog as New Session, including managed repository roots.
      const [projects, worktrees] = await Promise.all([
        scope.client.request<ProjectsListResult>("projects.list", {}),
        scope.client.request<WorktreesListResult>("worktrees.list", {}),
      ]);
      if (current()) {
        const roots = new Map<string, string>();
        for (const project of projects.projects) {
          if (project.repoRoot) {
            roots.set(project.repoRoot, project.displayName);
          }
        }
        for (const worktree of worktrees.worktrees) {
          if (!worktree.removedAt && !roots.has(worktree.repoRoot)) {
            roots.set(worktree.repoRoot, worktree.repoRoot);
          }
        }
        this.repositories = [...roots].map(([root, label]) => ({ root, label }));
      }
    } catch (error) {
      if (current()) {
        this.buildError = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.repositoriesLoading = false;
      }
    }
  }

  private async prepare(profileId: string, projectPath: string, fromDialog = false) {
    const scope = this.gateway.capture();
    if (!scope || this.preparing || !this.canCall("environments.prepare")) {
      return;
    }
    const eligible = this.result?.profiles.some(
      (profile) => profile.id === profileId && profile.warmImages === "on",
    );
    if (
      !eligible ||
      !projectPath ||
      (fromDialog && !this.repositories.some((repository) => repository.root === projectPath))
    ) {
      this.buildError = t("cloudWorkersPage.snapshots.selectBuildInputs");
      return;
    }
    this.preparing = true;
    this.buildError = null;
    this.error = null;
    this.notice = null;
    try {
      const result = await scope.client.request<{ reused: boolean }>("environments.prepare", {
        profileId,
        projectPath,
      });
      if (this.gateway.isCurrent(scope)) {
        this.closeBuildDialog();
        this.notice = t(
          result.reused
            ? "cloudWorkersPage.snapshots.buildReused"
            : "cloudWorkersPage.snapshots.buildStarted",
        );
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        const code =
          error instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(error) : null;
        const message =
          code === "capacity"
            ? t("cloudWorkersPage.snapshots.capacity")
            : code === "invalid_project"
              ? t("cloudWorkersPage.snapshots.invalidProject")
              : code === "invalid_profile" || code === "profile_not_found"
                ? t("cloudWorkersPage.snapshots.invalidProfile")
                : formatUiError(error);
        if (fromDialog) {
          this.buildError = message;
        } else {
          this.error = message;
        }
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.preparing = false;
      }
    }
  }

  private async cancelBuild(environment: EnvironmentSummary) {
    const scope = this.gateway.capture();
    if (!scope || this.cancelling || this.confirmation || !this.canCall("environments.destroy")) {
      return;
    }
    const confirmed = await this.confirm({
      title: t("cloudWorkersPage.snapshots.cancelBuild"),
      message: t("cloudWorkersPage.snapshots.cancelBuildMessage"),
      details: environment.id,
      confirmLabel: t("cloudWorkersPage.snapshots.cancelBuild"),
      danger: true,
    });
    if (!confirmed || !this.gateway.isCurrent(scope) || !this.canCall("environments.destroy")) {
      return;
    }
    this.cancelling = environment.id;
    this.error = null;
    this.notice = null;
    try {
      await scope.client.request("environments.destroy", { environmentId: environment.id });
      if (this.gateway.isCurrent(scope)) {
        this.notice = t("cloudWorkersPage.snapshots.buildCancelled");
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.cancelling = null;
      }
    }
  }

  private renderBuildDialog() {
    if (!this.buildDialog) {
      return nothing;
    }
    const valid =
      this.result?.profiles.some(
        (profile) => profile.id === this.buildProfile && profile.warmImages === "on",
      ) && this.repositories.some((repository) => repository.root === this.buildProject);
    return html`<openclaw-modal-dialog
      label=${t("cloudWorkersPage.snapshots.buildSnapshot")}
      @modal-cancel=${(event: Event) => {
        if (this.preparing) {
          event.preventDefault();
        } else {
          this.closeBuildDialog();
        }
      }}
    >
      <div class="exec-approval-card">
        <h2>${t("cloudWorkersPage.snapshots.buildSnapshot")}</h2>
        <p>${t("cloudWorkersPage.snapshots.buildHelp")}</p>
        <label class="field"
          ><span>${t("cloudWorkersPage.snapshots.profile")}</span>
          <select
            class="settings-select"
            .value=${this.buildProfile}
            ?disabled=${this.preparing}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                this.buildProfile = event.currentTarget.value;
              }
            }}
          >
            <option value="">${t("cloudWorkersPage.snapshots.chooseProfile")}</option>
            ${this.result?.profiles.map((profile) => html`<option value=${profile.id} ?disabled=${profile.warmImages !== "on"}>${profile.id}${profile.warmImages === "on" ? "" : ` — ${profile.reason}`}</option>`)}
          </select>
        </label>
        <label class="field"
          ><span>${t("cloudWorkersPage.snapshots.repository")}</span>
          <select
            class="settings-select"
            .value=${this.buildProject}
            ?disabled=${this.preparing || this.repositoriesLoading}
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                this.buildProject = event.currentTarget.value;
              }
            }}
          >
            <option value="">
              ${t(this.repositoriesLoading ? "common.loading" : "cloudWorkersPage.snapshots.chooseRepository")}
            </option>
            ${this.repositories.map((repository) => html`<option value=${repository.root}>${repository.label === repository.root ? repository.root : `${repository.label} · ${repository.root}`}</option>`)}
          </select>
        </label>
        ${!this.repositoriesLoading && !this.repositories.length && !this.buildError ? html`<p>${t("cloudWorkersPage.snapshots.noRepositories")}</p>` : nothing}
        ${this.buildError ? html`<div class="callout warning" role="alert">${this.buildError}</div>` : nothing}
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            type="button"
            ?disabled=${!valid || this.preparing || !this.canCall("environments.prepare")}
            @click=${() => void this.prepare(this.buildProfile, this.buildProject, true)}
          >
            ${t("cloudWorkersPage.snapshots.buildSnapshot")}
          </button>
          <button
            class="btn"
            type="button"
            ?disabled=${this.preparing}
            @click=${() => this.closeBuildDialog()}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>`;
  }

  private async recoverCapture(image: SnapshotImage) {
    const scope = this.gateway.capture();
    const selector = image.capture?.selector;
    if (
      !scope ||
      !selector ||
      image.capture?.phase !== "uncertain" ||
      this.recovering ||
      this.mutating ||
      this.confirmation ||
      !this.canCall("crabbox.images.recover")
    ) {
      return;
    }
    const confirmed = await this.confirm({
      title: t("cloudWorkersPage.snapshots.recoverTitle"),
      message: t("cloudWorkersPage.snapshots.recoverMessage"),
      details: selector,
      confirmLabel: t("cloudWorkersPage.snapshots.recover"),
      requiredAcknowledgement: t("cloudWorkersPage.snapshots.acknowledgement"),
    });
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
        const confirmed = await this.confirm({
          title: t(`cloudWorkersPage.snapshots.${action}Title`),
          message: t(`cloudWorkersPage.snapshots.${action}Message`),
          details: checkpointId,
          confirmLabel: t(`cloudWorkersPage.snapshots.${action}`),
          danger: action === "delete",
        });
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

  private renderImage(image: SnapshotImage, showMachineFacts: boolean) {
    const { profileId, projectRoot } = image;
    return renderSnapshotImage(image, {
      showMachineFacts,
      busy: this.loading || this.mutating !== null || this.recovering !== null,
      buildBusy: this.preparing || this.loading,
      deleteReason: this.deleteReason(image),
      onPin: this.canCall("crabbox.images.pin")
        ? (previous) => void this.mutateImage(image, "pin", previous)
        : undefined,
      onRollback: this.canCall("crabbox.images.rollback")
        ? () => void this.mutateImage(image, "rollback", true)
        : undefined,
      onDelete: this.canCall("crabbox.images.delete")
        ? () => void this.mutateImage(image, "delete")
        : undefined,
      onRecover: this.canCall("crabbox.images.recover")
        ? () => void this.recoverCapture(image)
        : undefined,
      onRebuild:
        projectRoot &&
        profileId &&
        this.result?.profiles.some(
          (profile) => profile.id === profileId && profile.warmImages === "on",
        ) &&
        this.canCall("environments.prepare")
          ? () => void this.prepare(profileId, projectRoot)
          : undefined,
    });
  }

  private renderImages(result: SnapshotsResult) {
    const groups = new Map<
      string | undefined,
      { profile?: SnapshotProfile; images: SnapshotImage[]; builds: EnvironmentSummary[] }
    >(result.profiles.map((profile) => [profile.id, { profile, images: [], builds: [] }]));
    for (const image of result.images) {
      const group = groups.get(image.profileId) ?? { images: [], builds: [] };
      group.images.push(image);
      groups.set(image.profileId, group);
    }
    for (const environment of [...this.builds, ...this.failedBuilds]) {
      const profileId = environment.worker?.profileId;
      const group = groups.get(profileId) ?? { images: [], builds: [] };
      group.builds.push(environment);
      groups.set(profileId, group);
    }
    const buildLeases = new Set(
      this.builds.flatMap((environment) =>
        environment.worker?.leaseId ? [environment.worker.leaseId] : [],
      ),
    );
    return html`
      ${renderSettingsSummary([
        {
          label: t("cloudWorkersPage.snapshots.images"),
          value: result.images.filter((image) => image.checkpointId).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.building"),
          value:
            this.builds.length +
            result.images.filter(
              (image) =>
                image.capture &&
                image.capture.phase !== "uncertain" &&
                (!image.capture.leaseId || !buildLeases.has(image.capture.leaseId)),
            ).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.held"),
          value: result.images.filter((image) => image.held).length,
        },
        {
          label: t("cloudWorkersPage.snapshots.attention"),
          value:
            this.failedBuilds.length +
            result.images.filter(
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
                  count: group.images.length + group.builds.length,
                },
                group.images.length || group.builds.length
                  ? html`${group.builds.map((entry) => renderSnapshotBuildRow(entry, this.cancelling !== null, this.canCall("environments.destroy") ? () => void this.cancelBuild(entry) : undefined))}${group.images.map((entry) => this.renderImage(entry, mixedMetadata))}`
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
          control: html`${this.canCall("environments.prepare") ? html`<button class="btn primary btn--sm" type="button" ?disabled=${this.loading || this.preparing} @click=${() => void this.openBuildDialog()}>${t("cloudWorkersPage.snapshots.buildSnapshot")}</button>` : nothing}<button
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
      ${this.renderBuildDialog()}
    `);
  }
}

if (!customElements.get("openclaw-cloud-worker-snapshots")) {
  customElements.define("openclaw-cloud-worker-snapshots", CloudWorkerSnapshots);
}
