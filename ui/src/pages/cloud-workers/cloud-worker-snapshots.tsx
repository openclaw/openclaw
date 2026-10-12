import { createStore, Show } from "solid-js";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
  ProjectsListResult,
  WorktreesListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import { showConfirmDialog, type ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { SnapshotBuildDialog } from "./cloud-worker-snapshot-build-dialog.tsx";
import { CloudWorkerSnapshotPolicy } from "./cloud-worker-snapshot-policy.tsx";
import {
  SnapshotInventory,
  SnapshotBuildRow,
  SnapshotImageRow,
  type SnapshotImage,
  type SnapshotsResult,
} from "./cloud-worker-snapshot-rows.tsx";

registerEnglishCatalog(registerSettingsEnglish);

export const CloudWorkerSnapshots = defineSolidBridge(
  "openclaw-cloud-worker-snapshots",
  () => {
    const context = useApplication();
    const [view, setView] = createStore<{
      result: SnapshotsResult | null;
      loading: boolean;
      mutating: string | null;
      recovering: string | null;
      error: string | null;
      notice: string | null;
      builds: EnvironmentSummary[];
      failedBuilds: EnvironmentSummary[];
      buildDialog: boolean;
      buildProfile: string;
      buildProject: string;
      repositories: { root: string; label: string }[];
      repositoriesLoading: boolean;
      buildError: string | null;
      preparing: boolean;
      destroying: string | null;
    }>({
      result: null,
      loading: false,
      mutating: null,
      recovering: null,
      error: null,
      notice: null,
      builds: [],
      failedBuilds: [],
      buildDialog: false,
      buildProfile: "",
      buildProject: "",
      repositories: [],
      repositoriesLoading: false,
      buildError: null,
      preparing: false,
      destroying: null,
    });

    const dismissed = new Set<string>();

    let refreshAgain = false;

    let pickerGeneration = 0;

    let pollTimer: ReturnType<typeof setTimeout> | undefined = undefined;

    let activeConfirmation: AbortController | null = null;

    const gateway = useGatewayPage({
      getGateway: () => context.gateway,
      invalidateRequests: () => {
        refreshAgain = false;
        stopPolling();
        closeBuildDialog();
        setView((draft) => {
          draft.builds = [];
          draft.failedBuilds = [];
          draft.preparing = false;
          draft.destroying = null;
        });
        dismissed.clear();
        setView((draft) => {
          draft.result = null;
          draft.loading = false;
          draft.recovering = null;
          draft.mutating = null;
          draft.error = null;
          draft.notice = null;
        });
        activeConfirmation?.abort();
      },
      ensureInitialData: () => queueMicrotask(() => void load()),
    });

    function canCall(method: string) {
      return canCallGatewayMethod(gateway.snapshot, method, "operator.admin");
    }

    async function confirm(options: ConfirmDialogOptions) {
      const confirmation = new AbortController();
      activeConfirmation = confirmation;
      const confirmed = await showConfirmDialog({ ...options, signal: confirmation.signal });
      if (activeConfirmation === confirmation) {
        activeConfirmation = null;
      }
      return confirmed;
    }

    async function load() {
      const scope = gateway.capture();
      if (view.loading) {
        refreshAgain = true;
        return;
      }
      if (!scope || !canCall("crabbox.images.list")) {
        return;
      }
      setView((draft) => {
        draft.loading = true;
        draft.error = null;
      });
      try {
        const environments = await scope.client.request<EnvironmentsListResult>(
          "environments.list",
          {},
        );
        if (!gateway.isCurrent(scope)) {
          return;
        }
        const builds = environments.environments.filter(
          (environment) =>
            environment.preparation?.purpose === "build" &&
            environment.worker &&
            environment.worker.attachedSessionIds.length === 0,
        );
        setView((draft) => {
          draft.builds = builds.filter(
            (environment) =>
              environment.worker &&
              ["requested", "provisioning", "bootstrapping"].includes(environment.worker.state),
          );
          draft.failedBuilds = builds.filter(
            (environment) =>
              environment.worker &&
              ["failed", "orphaned"].includes(environment.worker.state) &&
              !dismissed.has(environment.id),
          );
        });
        if (
          builds.some(
            (environment) =>
              environment.worker &&
              ["failed", "orphaned"].includes(environment.worker.state) &&
              !dismissed.has(environment.id),
          )
        ) {
          setView((draft) => {
            draft.notice = null;
          });
        }
        // Capture settles before worker readiness; read images after that readiness snapshot.
        const result = await scope.client.request<SnapshotsResult>("crabbox.images.list", {});
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.result = result;
          });
        }
      } catch (error) {
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.error = formatUiError(error);
          });
        }
      } finally {
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.loading = false;
          });
          stopPolling();
          queueMicrotask(() => {
            if (!gateway.isCurrent(scope)) {
              return;
            }
            if (refreshAgain) {
              refreshAgain = false;
              void load();
            } else if (
              view.builds.length ||
              view.result?.images.some(
                (image) => image.capture && image.capture.phase !== "uncertain",
              )
            ) {
              pollTimer = setTimeout(() => void load(), 10_000);
            }
          });
        }
      }
    }

    function stopPolling() {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }

    function closeBuildDialog() {
      pickerGeneration += 1;
      setView((draft) => {
        draft.buildDialog = false;
        draft.repositories = [];
        draft.repositoriesLoading = false;
        draft.buildError = null;
      });
    }

    async function openBuildDialog() {
      const scope = gateway.capture();
      if (!scope || !canCall("environments.prepare") || view.preparing) {
        return;
      }
      const generation = ++pickerGeneration;
      setView((draft) => {
        draft.buildDialog = true;
        draft.buildProfile = "";
        draft.buildProject = "";
        draft.buildError = null;
        draft.repositories = [];
        draft.repositoriesLoading = true;
      });
      const current = () => gateway.isCurrent(scope) && generation === pickerGeneration;
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
          setView((draft) => {
            draft.repositories = [...roots].map(([root, label]) => ({ root, label }));
          });
        }
      } catch (error) {
        if (current()) {
          setView((draft) => {
            draft.buildError = formatUiError(error);
          });
        }
      } finally {
        if (current()) {
          setView((draft) => {
            draft.repositoriesLoading = false;
          });
        }
      }
    }

    async function prepare(profileId: string, projectPath: string, fromDialog = false) {
      const scope = gateway.capture();
      if (!scope || view.preparing || !canCall("environments.prepare")) {
        return;
      }
      const eligible = view.result?.profiles.some(
        (profile) => profile.id === profileId && profile.warmImages === "on",
      );
      if (
        !eligible ||
        !projectPath ||
        (fromDialog && !view.repositories.some((repository) => repository.root === projectPath))
      ) {
        setView((draft) => {
          draft.buildError = t("cloudWorkersPage.snapshots.selectBuildInputs");
        });
        return;
      }
      setView((draft) => {
        draft.preparing = true;
        draft.buildError = null;
        draft.error = null;
        draft.notice = null;
      });
      try {
        const result = await scope.client.request<{ reused: boolean }>("environments.prepare", {
          profileId,
          projectPath,
        });
        if (gateway.isCurrent(scope)) {
          closeBuildDialog();
          setView((draft) => {
            draft.notice = t(
              result.reused
                ? "cloudWorkersPage.snapshots.buildReused"
                : "cloudWorkersPage.snapshots.buildStarted",
            );
          });
          await load();
        }
      } catch (error) {
        if (gateway.isCurrent(scope)) {
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
          setView((draft) => {
            draft[fromDialog ? "buildError" : "error"] = message;
          });
        }
      } finally {
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.preparing = false;
          });
        }
      }
    }

    async function destroyBuild(environment: EnvironmentSummary, dismiss: boolean) {
      const scope = gateway.capture();
      if (!scope || view.destroying || activeConfirmation || !canCall("environments.destroy")) {
        return;
      }
      const confirmed = await confirm({
        title: t(`cloudWorkersPage.snapshots.${dismiss ? "dismissBuild" : "cancelBuild"}`),
        message: t(
          `cloudWorkersPage.snapshots.${dismiss ? "dismissBuildMessage" : "cancelBuildMessage"}`,
        ),
        details: environment.id,
        confirmLabel: t(`cloudWorkersPage.snapshots.${dismiss ? "dismiss" : "cancelBuild"}`),
        danger: !dismiss,
      });
      if (!confirmed || !gateway.isCurrent(scope) || !canCall("environments.destroy")) {
        return;
      }
      setView((draft) => {
        draft.destroying = environment.id;
        draft.error = null;
        draft.notice = null;
      });
      await runSnapshotMutation(scope, "destroying", async () => {
        await scope.client.request("environments.destroy", { environmentId: environment.id });
        if (gateway.isCurrent(scope)) {
          // The Gateway keeps a terminal build record until its retention window ends, so
          // clearing the row is a local view decision that lasts until this page reloads.
          if (dismiss) {
            dismissed.add(environment.id);
            setView((draft) => {
              draft.failedBuilds = view.failedBuilds.filter((build) => build.id !== environment.id);
            });
          }
          setView((draft) => {
            draft.notice = t(
              `cloudWorkersPage.snapshots.${dismiss ? "buildDismissed" : "buildCancelled"}`,
            );
          });
          await load();
        }
      });
    }

    async function recoverCapture(image: SnapshotImage) {
      const scope = gateway.capture();
      const selector = image.capture?.selector;
      if (
        !scope ||
        !selector ||
        image.capture?.phase !== "uncertain" ||
        view.recovering ||
        view.mutating ||
        activeConfirmation ||
        !canCall("crabbox.images.recover")
      ) {
        return;
      }
      const confirmed = await confirm({
        title: t("cloudWorkersPage.snapshots.recoverTitle"),
        message: t("cloudWorkersPage.snapshots.recoverMessage"),
        details: selector,
        confirmLabel: t("cloudWorkersPage.snapshots.recover"),
        requiredAcknowledgement: t("cloudWorkersPage.snapshots.acknowledgement"),
      });
      if (!confirmed) {
        return;
      }
      if (!gateway.isCurrent(scope) || !canCall("crabbox.images.recover")) {
        setView((draft) => {
          draft.error = t("cloudWorkersPage.snapshots.recoveryChanged");
        });
        return;
      }
      setView((draft) => {
        draft.recovering = selector;
        draft.error = null;
        draft.notice = null;
      });
      await runSnapshotMutation(scope, "recovering", async () => {
        await scope.client.request("crabbox.images.recover", {
          selector,
          acknowledgeProviderCleanup: true,
        });
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.notice = t("cloudWorkersPage.snapshots.recovered");
          });
          await load();
        }
      });
    }

    function deleteReason(image: SnapshotImage) {
      return image.pinned
        ? t("cloudWorkersPage.snapshots.deletePinned")
        : image.held
          ? t("cloudWorkersPage.snapshots.deleteHeld")
          : image.capture
            ? t("cloudWorkersPage.snapshots.deleteCapturing")
            : null;
    }

    async function mutateImage(
      image: SnapshotImage,
      action: "pin" | "delete" | "rollback",
      previous = false,
    ) {
      const scope = gateway.capture();
      const checkpoint = previous ? image.previous : image;
      const checkpointId = checkpoint?.checkpointId;
      const method = `crabbox.images.${action}`;
      if (
        !scope ||
        !checkpoint ||
        !checkpointId ||
        view.mutating ||
        view.recovering ||
        view.loading ||
        !canCall(method)
      ) {
        return;
      }
      if (
        (action === "delete" && deleteReason(image)) ||
        (action !== "delete" && (image.capture || image.retirement))
      ) {
        return;
      }
      setView((draft) => {
        draft.mutating = checkpointId;
      });
      await runSnapshotMutation(scope, "mutating", async () => {
        if (action !== "pin") {
          const confirmed = await confirm({
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
        if (!gateway.isCurrent(scope) || !canCall(method)) {
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
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.notice = notice;
          });
          await load();
        }
      });
    }

    async function runSnapshotMutation(
      scope: GatewayConnectionScope,
      busy: "mutating" | "recovering" | "destroying",
      mutate: () => Promise<void>,
    ) {
      try {
        await mutate();
      } catch (error) {
        if (gateway.isCurrent(scope)) {
          if (busy === "mutating") {
            showToast({ message: formatUiError(error) });
          } else {
            setView((draft) => {
              draft.error = formatUiError(error);
            });
          }
        }
      } finally {
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft[busy] = null;
          });
        }
      }
    }

    function renderBuildRow(environment: () => EnvironmentSummary) {
      // Orphaned builds still own provider artifacts; only failed builds can be dismissed.
      return (
        <SnapshotBuildRow
          environment={environment()}
          busy={view.destroying !== null}
          onDismiss={
            canCall("environments.destroy") && environment().worker?.state === "failed"
              ? () => void destroyBuild(environment(), true)
              : undefined
          }
          onCancel={
            canCall("environments.destroy") && environment().worker?.state !== "failed"
              ? () => void destroyBuild(environment(), false)
              : undefined
          }
        />
      );
    }

    function renderImage(image: () => SnapshotImage, showMachineFacts: () => boolean) {
      return (
        <SnapshotImageRow
          image={image()}
          showMachineFacts={showMachineFacts()}
          busy={view.loading || view.mutating !== null || view.recovering !== null}
          buildBusy={view.preparing || view.loading}
          deleteReason={deleteReason(image())}
          onPin={
            canCall("crabbox.images.pin")
              ? (previous) => void mutateImage(image(), "pin", previous)
              : undefined
          }
          onRollback={
            canCall("crabbox.images.rollback")
              ? () => void mutateImage(image(), "rollback", true)
              : undefined
          }
          onDelete={
            canCall("crabbox.images.delete") ? () => void mutateImage(image(), "delete") : undefined
          }
          onRecover={
            canCall("crabbox.images.recover") ? () => void recoverCapture(image()) : undefined
          }
          onRebuild={
            image().projectRoot &&
            image().profileId &&
            view.result?.profiles.some(
              (profile) => profile.id === image().profileId && profile.warmImages === "on",
            ) &&
            canCall("environments.prepare")
              ? () => {
                  const current = image();
                  if (current.profileId && current.projectRoot) {
                    void prepare(current.profileId, current.projectRoot);
                  }
                }
              : undefined
          }
        />
      );
    }

    const advertised = () =>
      isGatewayMethodAdvertised(gateway.snapshot ?? {}, "crabbox.images.list") === true;
    return (
      <SettingsPage>
        <Show
          when={advertised() && canCall("crabbox.images.list")}
          fallback={
            <SettingsEmpty
              message={t(
                advertised()
                  ? "cloudWorkersPage.snapshots.adminRequired"
                  : "cloudWorkersPage.snapshots.unavailable",
              )}
            />
          }
        >
          <>
            <SettingsSection>
              <SettingsRow
                title={t("cloudWorkersPage.snapshots.title")}
                control={
                  <>
                    {canCall("environments.prepare") ? (
                      <button
                        class="btn primary btn--sm"
                        type="button"
                        disabled={view.loading || view.preparing}
                        onClick={() => void openBuildDialog()}
                      >
                        {t("cloudWorkersPage.snapshots.buildSnapshot")}
                      </button>
                    ) : null}
                    <button
                      class="btn btn--sm"
                      type="button"
                      disabled={view.loading || view.recovering !== null || view.mutating !== null}
                      onClick={() => void load()}
                    >
                      {t("cloudWorkersPage.snapshots.refresh")}
                    </button>
                  </>
                }
              />
            </SettingsSection>
            {view.error ? (
              <div class="callout warning" role="alert">
                {view.error}
              </div>
            ) : null}
            {view.notice ? (
              <div class="callout" role="status">
                {view.notice}
              </div>
            ) : null}
            <Show
              when={Boolean(view.result || view.builds.length || view.failedBuilds.length)}
              fallback={view.loading ? <SettingsEmpty message={t("common.loading")} /> : null}
            >
              <SnapshotInventory
                result={view.result}
                builds={view.builds}
                failedBuilds={view.failedBuilds}
                buildRow={renderBuildRow}
                imageRow={renderImage}
              />
            </Show>
            <CloudWorkerSnapshotPolicy />
            <Show when={view.buildDialog}>
              <SnapshotBuildDialog
                profiles={view.result?.profiles ?? []}
                profile={view.buildProfile}
                project={view.buildProject}
                repositories={view.repositories}
                repositoriesLoading={view.repositoriesLoading}
                preparing={view.preparing}
                error={view.buildError}
                canPrepare={canCall("environments.prepare")}
                onProfile={(value) =>
                  setView((draft) => {
                    draft.buildProfile = value;
                  })
                }
                onProject={(value) =>
                  setView((draft) => {
                    draft.buildProject = value;
                  })
                }
                onBuild={() => void prepare(view.buildProfile, view.buildProject, true)}
                onClose={closeBuildDialog}
              />
            </Show>
          </>
        </Show>
      </SettingsPage>
    );
  },
  { properties: {} },
);
