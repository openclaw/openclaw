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
import { renderSnapshotBuildDialog } from "./cloud-worker-snapshot-build-dialog.ts";
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
  @state() private destroying: string | null = null;
  /** Failed builds the operator cleared; the Gateway keeps their records until retention. */
  private dismissed = new Set<string>();
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
      this.destroying = null;
      this.dismissed.clear();
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
          environment.worker &&
          ["failed", "orphaned"].includes(environment.worker.state) &&
          !this.dismissed.has(environment.id),
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

  /** Both build actions call environments.destroy; only dismissal clears a terminal row. */
  private async destroyBuild(environment: EnvironmentSummary, dismiss: boolean) {
    const scope = this.gateway.capture();
    if (!scope || this.destroying || this.confirmation || !this.canCall("environments.destroy")) {
      return;
    }
    const confirmed = await this.confirm({
      title: t(`cloudWorkersPage.snapshots.${dismiss ? "dismissBuild" : "cancelBuild"}`),
      message: t(
        `cloudWorkersPage.snapshots.${dismiss ? "dismissBuildMessage" : "cancelBuildMessage"}`,
      ),
      details: environment.id,
      confirmLabel: t(`cloudWorkersPage.snapshots.${dismiss ? "dismiss" : "cancelBuild"}`),
      danger: !dismiss,
    });
    if (!confirmed || !this.gateway.isCurrent(scope) || !this.canCall("environments.destroy")) {
      return;
    }
    this.destroying = environment.id;
    this.error = null;
    this.notice = null;
    try {
      await scope.client.request("environments.destroy", { environmentId: environment.id });
      if (this.gateway.isCurrent(scope)) {
        // The Gateway keeps a terminal build record until its retention window ends, so
        // clearing the row is a local view decision that lasts until this page reloads.
        if (dismiss) {
          this.dismissed.add(environment.id);
        }
        this.notice = t(
          `cloudWorkersPage.snapshots.${dismiss ? "buildDismissed" : "buildCancelled"}`,
        );
        await this.load();
      }
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.destroying = null;
      }
    }
  }

  private renderBuildDialog() {
    if (!this.buildDialog) {
      return nothing;
    }
    return renderSnapshotBuildDialog({
      profiles: this.result?.profiles ?? [],
      repositories: this.repositories,
      repositoriesLoading: this.repositoriesLoading,
      profileId: this.buildProfile,
      projectPath: this.buildProject,
      preparing: this.preparing,
      canPrepare: this.canCall("environments.prepare"),
      error: this.buildError,
      onProfileChange: (value) => {
        this.buildProfile = value;
      },
      onProjectChange: (value) => {
        this.buildProject = value;
      },
      onSubmit: () => void this.prepare(this.buildProfile, this.buildProject, true),
      onClose: () => this.closeBuildDialog(),
    });
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

  private renderBuildRow(environment: EnvironmentSummary) {
    // Orphaned records still track provider artifacts awaiting cleanup, so only a failed
    // build offers dismissal; an active one still offers cancellation.
    const action = !this.canCall("environments.destroy")
      ? {}
      : environment.worker?.state === "failed"
        ? { onDismiss: () => void this.destroyBuild(environment, true) }
        : { onCancel: () => void this.destroyBuild(environment, false) };
    return renderSnapshotBuildRow(environment, { busy: this.destroying !== null, ...action });
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

  private renderImages(result: SnapshotsResult | null) {
    const groups = new Map<
      string | undefined,
      { profile?: SnapshotProfile; images: SnapshotImage[]; builds: EnvironmentSummary[] }
    >((result?.profiles ?? []).map((profile) => [profile.id, { profile, images: [], builds: [] }]));
    for (const image of result?.images ?? []) {
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
      ${
        result
          ? renderSettingsSummary([
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
                      image.retirement ||
                      image.capture?.phase === "uncertain" ||
                      image.capture?.stale,
                  ).length,
              },
            ])
          : nothing
      }
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
                  ? html`${group.builds.map((entry) => this.renderBuildRow(entry))}${group.images.map((entry) => this.renderImage(entry, mixedMetadata))}`
                  : renderSettingsEmpty(t("cloudWorkersPage.snapshots.profileEmpty")),
              );
            })
          : renderSettingsEmpty(t("cloudWorkersPage.snapshots.empty"))
      }
      ${
        result?.legacyLeases.length
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
      ${this.result || this.builds.length || this.failedBuilds.length ? this.renderImages(this.result) : this.loading ? renderSettingsEmpty(t("common.loading")) : nothing}
      <openclaw-cloud-worker-snapshot-policy></openclaw-cloud-worker-snapshot-policy>
      ${this.renderBuildDialog()}
    `);
  }
}

if (!customElements.get("openclaw-cloud-worker-snapshots")) {
  customElements.define("openclaw-cloud-worker-snapshots", CloudWorkerSnapshots);
}
