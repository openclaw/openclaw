import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  createStore,
  For,
  Show,
  onCleanup,
} from "solid-js";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import { showConfirmDialog, type ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import {
  DocsLink,
  SettingsEmpty,
  SettingsPage,
  SettingsSection,
  SettingsRow,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { showToast } from "../../lib/toast.ts";
import {
  cloudEnvironments,
  environmentState,
  isUnassignedPreparation,
  showPreparationRow,
  type SnapshotImage,
  type SnapshotsResult,
} from "./cloud-worker-environment-model.ts";
import { CloudWorkerMachinePool } from "./cloud-worker-machine-pool.tsx";
import { readCloudWorkerRepositories } from "./cloud-worker-repositories-config.ts";
import { CloudWorkerSnapshotPolicy } from "./cloud-worker-snapshot-policy.tsx";
import {
  CloudWorkerBuildRow,
  CloudWorkerEnvironmentSheet,
  CloudWorkerSnapshotRow,
} from "./cloud-worker-snapshot-rows.tsx";
import "./cloud-worker-environments.css";

registerEnglishCatalog(registerSettingsEnglish);

export function CloudWorkerEnvironments(props: { machines: () => JSX.Element }) {
  const context = useApplication();
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const [selected, setSelected] = createSignal<string | null>(null, { ownedWrite: true });
  const [view, setView] = createStore<{
    result: SnapshotsResult | null;
    loading: boolean;
    mutating: string | null;
    recovering: string | null;
    error: string | null;
    notice: string | null;
    inventory: EnvironmentsListResult | null;
    preparing: boolean;
    destroying: string | null;
  }>({
    result: null,
    loading: false,
    mutating: null,
    recovering: null,
    error: null,
    notice: null,
    inventory: null,
    preparing: false,
    destroying: null,
  });

  const dismissed = new Set<string>();

  let refreshAgain = false;
  let activeLoad: object | undefined;

  let pollTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  let activeConfirmation: AbortController | null = null;

  function clearPresentation() {
    setSelected(null);
    dismissed.clear();
    setView((draft) => {
      draft.inventory = null;
      draft.result = null;
    });
  }

  function invalidateRequests() {
    refreshAgain = false;
    activeLoad = undefined;
    stopPolling();
    setView((draft) => {
      draft.preparing = false;
      draft.destroying = null;
      draft.loading = false;
      draft.recovering = null;
      draft.mutating = null;
      draft.error = null;
      draft.notice = null;
    });
    activeConfirmation?.abort();
  }

  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: clearPresentation,
    onSnapshot: ({ snapshot }) => {
      if (
        snapshot.phase === "connected" &&
        !canCallGatewayMethod(snapshot, "environments.list", "operator.admin")
      ) {
        gateway.invalidate();
        invalidateRequests();
        clearPresentation();
      }
    },
    invalidateRequests,
    ensureInitialData: () => queueMicrotask(() => void load()),
    onPageActivation: () => void load(),
  });
  // Config receipts and permissions invalidate the Gateway environment inventory.
  createEffect(
    () =>
      [
        runtime.read().state.configSnapshot?.appliedConfigHash,
        canCall("crabbox.images.list"),
      ] as const,
    (current, previous) => {
      if (previous?.some((value, index) => value !== current[index])) {
        queueMicrotask(() => void load());
      }
    },
  );

  onCleanup(() => {
    stopPolling();
    activeConfirmation?.abort();
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
    if (activeLoad) {
      refreshAgain = true;
      return;
    }
    if (!scope || !canCall("environments.list") || document.visibilityState === "hidden") {
      return;
    }
    const request = {};
    activeLoad = request;
    setView((draft) => {
      draft.loading = true;
      draft.error = null;
    });
    try {
      const environments = await scope.client.request<EnvironmentsListResult>("environments.list", {
        includePreparedDetails: true,
      });
      if (!gateway.isCurrent(scope)) {
        return;
      }
      setView((draft) => {
        draft.inventory = {
          ...environments,
          environments: environments.environments.filter(
            (environment) => !dismissed.has(environment.id),
          ),
        };
      });
      const builds = environments.environments.filter(
        (environment) =>
          environment.preparation &&
          environment.worker &&
          environment.worker.attachedSessionIds.length === 0,
      );
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
      const result = canCall("crabbox.images.list")
        ? await scope.client.request<SnapshotsResult>("crabbox.images.list", {})
        : null;
      if (gateway.isCurrent(scope)) {
        setView((draft) => {
          draft.result = result;
          if (result?.images.some((image) => image.recipePreparation?.failure)) {
            draft.notice = null;
          }
        });
      }
    } catch (error) {
      if (gateway.isCurrent(scope)) {
        setView((draft) => {
          draft.error = formatUiError(error);
        });
      }
    } finally {
      if (gateway.isCurrent(scope) && activeLoad === request) {
        activeLoad = undefined;
        setView((draft) => {
          draft.loading = false;
        });
        stopPolling();
        // This native microtask samples settled state once for polling, without subscribing.
        queueMicrotask(() => {
          if (!gateway.isCurrent(scope)) {
            return;
          }
          if (refreshAgain) {
            refreshAgain = false;
            void load();
          } else if (
            view.inventory?.environments.some(
              (environment) =>
                environment.preparation &&
                environment.worker &&
                !environment.worker.attachedSessionIds.length &&
                ["requested", "provisioning", "bootstrapping", "ready"].includes(
                  environment.worker.state,
                ),
            ) ||
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

  async function prepare(profileId: string, projectPath: string) {
    const scope = gateway.capture();
    if (!scope || view.preparing || !canCall("environments.prepare")) {
      return;
    }
    const eligible = view.result?.profiles.some(
      (profile) => profile.id === profileId && profile.warmImages === "on",
    );
    if (!eligible || !projectPath) {
      setView((draft) => {
        draft.error = t("cloudWorkersPage.snapshots.selectBuildInputs");
      });
      return;
    }
    setView((draft) => {
      draft.preparing = true;
      draft.error = null;
      draft.notice = null;
    });
    try {
      const result = await scope.client.request<{ reused: boolean }>("environments.prepare", {
        profileId,
        projectPath,
      });
      if (gateway.isCurrent(scope)) {
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
          draft.error = message;
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
            if (draft.inventory) {
              draft.inventory.environments = draft.inventory.environments.filter(
                (worker) => worker.id !== environment.id,
              );
            }
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

  const environments = createMemo(() =>
    cloudEnvironments(
      view.result?.images ?? [],
      view.inventory,
      readCloudWorkerRepositories(
        resolveEditableSnapshotConfig(runtime.read().state.configSnapshot),
      ),
    ),
  );
  const unlabeledImages = createMemo(() =>
    (view.result?.images ?? [])
      .filter((image) => !image.projectKey && !image.projectLabel && !image.projectRoot)
      .toSorted((a, b) => (a.profileId ?? a.profileKey).localeCompare(b.profileId ?? b.profileKey)),
  );
  const unlabeledBuilds = createMemo(() =>
    (view.inventory?.environments ?? []).filter(
      (environment) =>
        isUnassignedPreparation(environment) &&
        !environment.preparation?.details?.project?.label &&
        showPreparationRow(environment),
    ),
  );
  const current = createMemo(
    () => environments().find((environment) => environment.key === selected()) ?? environments()[0],
  );
  const advertised = () =>
    isGatewayMethodAdvertised(gateway.snapshot ?? {}, "environments.list") === true;
  return (
    <>
      <SettingsPage>
        <Show
          when={(advertised() && canCall("environments.list")) || view.inventory !== null}
          fallback={
            gateway.connected ? (
              <SettingsEmpty message={t("cloudWorkersPage.environments.adminRequired")} />
            ) : undefined
          }
        >
          <Show when={view.error}>
            <div class="callout warning" role="alert">
              {view.error}
            </div>
          </Show>
          <Show when={view.notice}>
            <div class="callout" role="status">
              {view.notice}
            </div>
          </Show>
          <Show
            when={environments().length}
            fallback={
              <SettingsEmpty
                message={
                  view.loading ? (
                    t("common.loading")
                  ) : (
                    <>
                      {t("cloudWorkersPage.environments.empty")}{" "}
                      <DocsLink url="https://docs.openclaw.ai/gateway/cloud-workers">
                        {t("cloudWorkersPage.environments.docs")}
                      </DocsLink>
                    </>
                  )
                }
              />
            }
          >
            <div class="cloud-environments">
              <div
                class="cloud-environments__list"
                aria-label={t("cloudWorkersPage.environments.repositories")}
              >
                <For each={environments()} keyed={(environment) => environment.key}>
                  {(environment) => {
                    const state = () => environmentState(environment());
                    const age = () => {
                      const builtAt = environment()
                        .images.filter((image) => image.state === "available")
                        .toSorted(
                          (a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0),
                        )[0]?.createdAtMs;
                      const worker = environment().workers.find(
                        (candidate) => candidate.worker?.state === "ready",
                      )?.worker;
                      return builtAt ?? (worker ? Date.now() - worker.ageMs : undefined);
                    };
                    return (
                      <button
                        type="button"
                        class={[
                          "cloud-environments__row",
                          {
                            "cloud-environments__row--selected":
                              current()?.key === environment().key,
                          },
                        ]}
                        aria-pressed={current()?.key === environment().key ? "true" : "false"}
                        onClick={() => setSelected(environment().key)}
                      >
                        <span>{environment().label}</span>
                        <span class="cloud-environments__status">
                          {t(`cloudWorkersPage.environments.${state()}`)}
                          {state() === "ready" && age() !== undefined
                            ? ` · ${formatRelativeTimestamp(age())}`
                            : ""}
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
              <Show when={current()}>
                {(environment) => (
                  <CloudWorkerEnvironmentSheet
                    environment={environment()}
                    profiles={view.result?.profiles ?? []}
                    busy={
                      view.loading ||
                      view.mutating !== null ||
                      view.recovering !== null ||
                      view.preparing
                    }
                    canCall={canCall}
                    deleteReason={deleteReason}
                    onRebuild={(profile, root) => void prepare(profile, root)}
                    onMutate={(snapshot, action, previous) =>
                      void mutateImage(snapshot, action, previous)
                    }
                    onRecover={(snapshot) => void recoverCapture(snapshot)}
                    onDestroy={(worker, dismiss) => void destroyBuild(worker, dismiss)}
                    destroying={view.destroying !== null}
                  />
                )}
              </Show>
            </div>
          </Show>
        </Show>
      </SettingsPage>
      <SettingsPage>
        <details class="cloud-environments__advanced">
          <summary>{t("cloudWorkersPage.environments.advanced")}</summary>
          {props.machines()}
          <CloudWorkerMachinePool inventory={view.inventory} />
          <CloudWorkerSnapshotPolicy />
          <Show
            when={
              unlabeledImages().length ||
              view.result?.legacyLeases.length ||
              unlabeledBuilds().length
            }
          >
            <SettingsSection title={t("cloudWorkersPage.environments.machineImages")}>
              <For each={unlabeledImages()} keyed={(image) => image.profileKey}>
                {(image) => (
                  <CloudWorkerSnapshotRow
                    image={image()}
                    label={image().profileId ?? image().profileKey}
                    actions
                    busy={view.loading || view.mutating !== null || view.recovering !== null}
                    canCall={canCall}
                    deleteReason={deleteReason}
                    onMutate={(snapshot, action, previous) =>
                      void mutateImage(snapshot, action, previous)
                    }
                    onRecover={(snapshot) => void recoverCapture(snapshot)}
                  />
                )}
              </For>
              <For each={unlabeledBuilds()} keyed={(worker) => worker.id}>
                {(worker) => (
                  <CloudWorkerBuildRow
                    environment={worker()}
                    label={worker().worker?.profileId ?? worker().id}
                    destroying={view.destroying !== null}
                    canCall={canCall}
                    onDestroy={(environment, dismiss) => void destroyBuild(environment, dismiss)}
                  />
                )}
              </For>
              <For each={view.result?.legacyLeases ?? []} keyed={(lease) => lease.leaseId}>
                {(lease) => (
                  <SettingsRow title={lease().leaseId} description={lease().recoveryHint} />
                )}
              </For>
            </SettingsSection>
          </Show>
        </details>
      </SettingsPage>
    </>
  );
}
