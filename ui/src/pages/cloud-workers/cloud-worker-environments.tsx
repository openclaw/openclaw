import type { JSX } from "@solidjs/web";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  createStore,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Show,
  onSettled,
} from "solid-js";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../../api/gateway.ts";
import { showConfirmDialog, type ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import { SettingsDisclosure } from "../../components/solid/settings-disclosure.tsx";
import {
  DocsLink,
  SettingsPage,
  SettingsSection,
  SettingsRow,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { i18n } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError, UserFacingError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { createTimeout } from "../../lib/reactive/timers.ts";
import { showToast } from "../../lib/toast.ts";
import {
  cloudEnvironments,
  environmentState,
  isUnassignedPreparation,
  showPreparationRow,
  type CloudEnvironment,
  type SnapshotImage,
  type SnapshotsResult,
} from "./cloud-worker-environment-model.ts";
import { CloudWorkerPoolSettings } from "./cloud-worker-pool-settings.tsx";
import { readCloudWorkerRepositories } from "./cloud-worker-repositories-config.ts";
import {
  CloudWorkerBuildRow,
  CloudWorkerEnvironmentSheet,
  CloudWorkerSnapshotRow,
} from "./cloud-worker-snapshot-rows.tsx";
import "./cloud-worker-environments.css";

registerEnglishCatalog(registerSettingsEnglish);

type MutationKind = "preparing" | "mutating" | "recovering" | "destroying";
type MutationSlot = "preparing" | "image" | "destroying";
const STATE_STATUS = {
  ready: "ok",
  building: "muted",
  coldOnly: "muted",
  attention: "warn",
} as const;
const preparationErrors = new Map([
  ["capacity", "capacity"],
  ["invalid_project", "invalidProject"],
  ["invalid_profile", "invalidProfile"],
  ["profile_not_found", "invalidProfile"],
]);

export function CloudWorkerEnvironments(props: { machines: () => JSX.Element }) {
  const context = useApplication();
  const runtime = projectRuntimeConfig(context.runtimeConfig);
  const [view, setView] = createStore<{
    result: SnapshotsResult | null;
    inventory: EnvironmentsListResult | null;
  }>({
    result: null,
    inventory: null,
  });
  const [loadRequest, setLoadRequest] = createSignal<{ promise: Promise<void> }>();
  const readPending = createMemo<boolean>(() => loadRequest()?.promise.then(() => false) ?? false, {
    loadingValue: true,
  });
  // Keep accepted inventory visible while optional image details are still loading.
  const loading = () => isPending(readPending) || latest(readPending);
  const operations: Partial<Record<MutationSlot, GatewayConnectionScope>> = {};
  let presentationLifetime = Promise.withResolvers<void>();
  const [feedback, setFeedback] = createSignal<Promise<void> | null>(null);
  const completion = createMemo(() => feedback()?.then(() => null) ?? null);

  function showFeedback(promise: Promise<void>) {
    void setFeedback(() => promise);
    // The error boundary may retire before its admitted work settles.
    void promise.catch(() => {});
  }

  const dismissed = new Set<string>();

  let refreshAgain = false;
  let activeLoad: object | undefined;

  const polling = createTimeout(() => void load(), 10_000);
  let previousInputs: readonly [string | null | undefined, boolean] | undefined;

  let activeConfirmation: AbortController | null = null;

  function clearPresentation() {
    dismissed.clear();
    setView((draft) => {
      draft.inventory = null;
      draft.result = null;
    });
  }

  function invalidateRequests() {
    presentationLifetime.resolve();
    presentationLifetime = Promise.withResolvers<void>();
    refreshAgain = false;
    activeLoad = undefined;
    delete operations.preparing;
    delete operations.image;
    delete operations.destroying;
    setFeedback(null);
    polling.cancel();
    setLoadRequest(undefined);
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
      syncInventoryInputs();
    },
    invalidateRequests,
    ensureInitialData: () => queueMicrotask(() => void load()),
    onPageActivation: () => void load(),
  });
  const connectionEpoch = createMemo(() => gateway.epoch);
  const presentation = createMemo(() => {
    const epoch = connectionEpoch();
    const [preparing, setPreparing] = createOptimistic(false);
    const [image, setImage] = createOptimistic(false);
    const [destroying, setDestroying] = createOptimistic(false);
    return {
      epoch,
      preparing: { read: preparing, write: setPreparing },
      image: { read: image, write: setImage },
      destroying: { read: destroying, write: setDestroying },
    };
  });
  const presentMutation = action(function* (
    current: ReturnType<typeof presentation>,
    slot: MutationSlot,
    settled: Promise<void>,
    retired: Promise<void>,
  ) {
    if (current.epoch === gateway.readEpoch()) {
      current[slot].write(true);
    }
    yield Promise.race([settled, retired]);
  });
  function syncInventoryInputs() {
    const current = [
      context.runtimeConfig.state.configSnapshot?.appliedConfigHash,
      canCallGatewayMethod(context.gateway.snapshot, "crabbox.images.list", "operator.admin"),
    ] as const;
    const changed = previousInputs?.some((value, index) => value !== current[index]);
    previousInputs = current;
    if (changed) {
      queueMicrotask(() => void load());
    }
  }
  onSettled(() => {
    // Config and permission receipts invalidate the inventory at their synchronous owners.
    const stop = runtime.subscribe(syncInventoryInputs);
    syncInventoryInputs();
    return () => {
      stop();
      activeConfirmation?.abort();
    };
  });

  const canCall = (method: string) =>
    canCallGatewayMethod(gateway.snapshot, method, "operator.admin");

  const canCallNow = (method: string) =>
    canCallGatewayMethod(context.gateway.snapshot, method, "operator.admin");

  async function confirm(options: ConfirmDialogOptions) {
    const confirmation = new AbortController();
    activeConfirmation = confirmation;
    const confirmed = await showConfirmDialog({ ...options, signal: confirmation.signal });
    if (activeConfirmation === confirmation) {
      activeConfirmation = null;
    }
    return confirmed;
  }

  function load() {
    const scope = gateway.capture();
    if (activeLoad) {
      refreshAgain = true;
      return undefined;
    }
    if (!scope || !canCallNow("environments.list") || document.visibilityState === "hidden") {
      return undefined;
    }
    const request = {};
    activeLoad = request;
    const promise = (async () => {
      try {
        const inventory = await scope.client.request<EnvironmentsListResult>("environments.list", {
          includePreparedDetails: true,
        });
        if (!gateway.isCurrent(scope)) {
          return;
        }
        setView((draft) => {
          draft.inventory = {
            ...inventory,
            environments: inventory.environments.filter(
              (environment) => !dismissed.has(environment.id),
            ),
          };
        });
        // Capture settles before worker readiness; read images after that readiness snapshot.
        const result = canCallNow("crabbox.images.list")
          ? await scope.client.request<SnapshotsResult>("crabbox.images.list", {})
          : null;
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.result = result;
          });
        }
      } catch (error) {
        if (gateway.isCurrent(scope)) {
          throw error;
        }
      } finally {
        if (gateway.isCurrent(scope) && activeLoad === request) {
          activeLoad = undefined;
          polling.cancel();
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
                  isUnassignedPreparation(environment) &&
                  ["requested", "provisioning", "bootstrapping", "ready"].includes(
                    environment.worker?.state ?? "",
                  ),
              ) ||
              view.result?.images.some(
                (image) => image.capture && image.capture.phase !== "uncertain",
              )
            ) {
              polling.schedule();
            }
          });
        }
      }
    })();
    const settled = promise.catch(() => {});
    setLoadRequest({ promise: settled });
    showFeedback(promise);
    return settled;
  }

  function prepare(profileId: string, projectPath: string) {
    const scope = gateway.capture();
    if (!scope || operations.preparing || !canCallNow("environments.prepare")) {
      return;
    }
    const eligible = view.result?.profiles.some(
      (profile) => profile.id === profileId && profile.warmImages === "on",
    );
    if (!eligible || !projectPath) {
      showFeedback(
        Promise.reject(new Error(i18n.t("cloudWorkersPage.snapshots.selectBuildInputs"))),
      );
      return;
    }
    void runSnapshotMutation(scope, "preparing", async () => {
      const result = await scope.client.request<{ reused: boolean }>("environments.prepare", {
        profileId,
        projectPath,
      });
      if (gateway.isCurrent(scope)) {
        showToast({
          message: i18n.t(
            result.reused
              ? "cloudWorkersPage.snapshots.buildReused"
              : "cloudWorkersPage.snapshots.buildStarted",
          ),
        });
        await load();
      }
    });
  }

  async function destroyBuild(environment: EnvironmentSummary, dismiss: boolean) {
    const scope = gateway.capture();
    const environmentId = environment.id;
    if (
      !scope ||
      operations.destroying ||
      activeConfirmation ||
      !canCallNow("environments.destroy")
    ) {
      return;
    }
    const confirmed = await confirm({
      title: i18n.t(`cloudWorkersPage.snapshots.${dismiss ? "dismissBuild" : "cancelBuild"}`),
      message: i18n.t(
        `cloudWorkersPage.snapshots.${dismiss ? "dismissBuildMessage" : "cancelBuildMessage"}`,
      ),
      details: environmentId,
      confirmLabel: i18n.t(`cloudWorkersPage.snapshots.${dismiss ? "dismiss" : "cancelBuild"}`),
      danger: !dismiss,
    });
    if (!confirmed || !gateway.isCurrent(scope) || !canCallNow("environments.destroy")) {
      return;
    }
    await runSnapshotMutation(scope, "destroying", async () => {
      await scope.client.request("environments.destroy", { environmentId });
      if (gateway.isCurrent(scope)) {
        // The Gateway keeps a terminal build record until its retention window ends, so
        // clearing the row is a local view decision that lasts until this page reloads.
        if (dismiss) {
          dismissed.add(environmentId);
          setView((draft) => {
            if (draft.inventory) {
              draft.inventory.environments = draft.inventory.environments.filter(
                (worker) => worker.id !== environmentId,
              );
            }
          });
        }
        showToast({
          message: i18n.t(
            `cloudWorkersPage.snapshots.${dismiss ? "buildDismissed" : "buildCancelled"}`,
          ),
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
      operations.image ||
      activeConfirmation ||
      !canCallNow("crabbox.images.recover")
    ) {
      return;
    }
    const confirmed = await confirm({
      title: i18n.t("cloudWorkersPage.snapshots.recoverTitle"),
      message: i18n.t("cloudWorkersPage.snapshots.recoverMessage"),
      details: selector,
      confirmLabel: i18n.t("cloudWorkersPage.snapshots.recover"),
      requiredAcknowledgement: i18n.t("cloudWorkersPage.snapshots.acknowledgement"),
    });
    if (!confirmed) {
      return;
    }
    if (!gateway.isCurrent(scope) || !canCallNow("crabbox.images.recover")) {
      showFeedback(Promise.reject(new Error(i18n.t("cloudWorkersPage.snapshots.recoveryChanged"))));
      return;
    }
    await runSnapshotMutation(scope, "recovering", async () => {
      await scope.client.request("crabbox.images.recover", {
        selector,
        acknowledgeProviderCleanup: true,
      });
      if (gateway.isCurrent(scope)) {
        showToast({ message: i18n.t("cloudWorkersPage.snapshots.recovered") });
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

  function mutateImage(
    image: SnapshotImage,
    operation: "pin" | "delete" | "rollback",
    previous = false,
  ) {
    const scope = gateway.capture();
    const checkpoint = previous ? image.previous : image;
    const checkpointId = checkpoint?.checkpointId;
    const method = `crabbox.images.${operation}`;
    if (
      !scope ||
      !checkpoint ||
      !checkpointId ||
      operations.image ||
      activeLoad ||
      !canCallNow(method)
    ) {
      return;
    }
    if (
      (operation === "delete" && deleteReason(image)) ||
      (operation !== "delete" && (image.capture || image.retirement))
    ) {
      return;
    }
    void runSnapshotMutation(scope, "mutating", async () => {
      if (operation !== "pin") {
        const confirmed = await confirm({
          title: i18n.t(`cloudWorkersPage.snapshots.${operation}Title`),
          message: i18n.t(`cloudWorkersPage.snapshots.${operation}Message`),
          details: checkpointId,
          confirmLabel: i18n.t(`cloudWorkersPage.snapshots.${operation}`),
          danger: operation === "delete",
        });
        if (!confirmed) {
          return;
        }
      }
      if (!gateway.isCurrent(scope) || !canCallNow(method)) {
        return;
      }
      if (operation === "delete") {
        const result = await scope.client.request<{ status: "deleted" | "retiring" }>(method, {
          checkpointId,
        });
        if (result.status === "retiring") {
          showToast({ message: i18n.t("cloudWorkersPage.snapshots.deletionRetiring") });
        }
      } else {
        await scope.client.request<SnapshotImage>(method, {
          checkpointId,
          ...(operation === "pin" ? { pinned: !checkpoint.pinned } : {}),
        });
      }
      if (gateway.isCurrent(scope)) {
        await load();
      }
    });
  }

  async function runSnapshotMutation(
    scope: GatewayConnectionScope,
    kind: MutationKind,
    mutate: () => Promise<void>,
  ) {
    const slot = kind === "mutating" || kind === "recovering" ? "image" : kind;
    if (operations[slot]) {
      return;
    }
    const current = presentation();
    const retired = presentationLifetime.promise;
    operations[slot] = scope;
    const pending = (async () => {
      try {
        await mutate();
      } catch (error) {
        if (gateway.isCurrent(scope)) {
          if (kind === "mutating") {
            showToast({ message: formatUiError(error) });
          } else {
            const code =
              error instanceof GatewayRequestError ? resolveGatewayErrorDetailCode(error) : null;
            const key = kind === "preparing" && code ? preparationErrors.get(code) : undefined;
            throw new UserFacingError(
              key ? i18n.t(`cloudWorkersPage.snapshots.${key}`) : formatUiError(error),
              { cause: error },
            );
          }
        }
      } finally {
        if (operations[slot] === scope) {
          delete operations[slot];
        }
      }
    })();
    const settled = pending.catch(() => {});
    if (kind !== "mutating") {
      showFeedback(pending);
    }
    // Commit owner receipts before starting a presentation-only action transition.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (operations[slot] === scope && gateway.isCurrent(scope)) {
      await presentMutation(current, slot, settled, retired);
    }
    return settled;
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
  function RepositoryRow(row: { environment: CloudEnvironment }) {
    // Until someone opens or closes it: the only repository and a failure's reason are shown.
    const [userOpen, setUserOpen] = createSignal<boolean | undefined>(undefined, {
      ownedWrite: true,
    });
    const state = () => environmentState(row.environment);
    const age = () => {
      const builtAt = row.environment.images
        .filter((image) => image.state === "available")
        .toSorted((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0))[0]?.createdAtMs;
      const worker = row.environment.workers.find((w) => w.worker?.state === "ready")?.worker;
      return builtAt ?? (worker ? Date.now() - worker.ageMs : undefined);
    };
    return (
      <SettingsDisclosure
        nested
        class="cloud-environments__repository"
        summaryClass="cloud-environments__row"
        title={row.environment.label}
        open={userOpen() ?? (state() === "attention" || environments().length === 1)}
        onToggle={(event) => setUserOpen(event.currentTarget.open)}
        control={
          // Configured defaults list before anything is known about them.
          <Show when={view.inventory || view.result}>
            <SettingsStatus
              kind={STATE_STATUS[state()]}
              label={
                <>
                  {t(`cloudWorkersPage.environments.${state()}`)}
                  {state() === "ready" && age() !== undefined
                    ? ` · ${formatRelativeTimestamp(age())}`
                    : ""}
                </>
              }
            />
          </Show>
        }
      >
        <CloudWorkerEnvironmentSheet
          environment={row.environment}
          profiles={view.result?.profiles ?? []}
          busy={presentation().image.read() || presentation().preparing.read() || loading()}
          canCall={canCall}
          deleteReason={deleteReason}
          onRebuild={prepare}
          onMutate={mutateImage}
          onRecover={(snapshot) => void recoverCapture(snapshot)}
          onDestroy={(item, dismiss) => void destroyBuild(item, dismiss)}
          destroying={presentation().destroying.read()}
        />
      </SettingsDisclosure>
    );
  }
  return (
    <SettingsPage>
      <Show when={gateway.connected && !canCall("environments.list") && view.inventory === null}>
        <SettingsSection>
          <SettingsRow
            role="status"
            title={
              <span class="cloud-environments__empty">
                {t("cloudWorkersPage.environments.adminRequired")}
              </span>
            }
          />
        </SettingsSection>
      </Show>
      {props.machines()}
      <Show when={canCall("environments.list") || view.inventory !== null}>
        <SettingsSection
          title={t("cloudWorkersPage.environments.repositories")}
          notice={
            <Loading on={feedback()}>
              <Errored
                fallback={(err) => (
                  <div class="callout warning" role="alert">
                    {formatUiError(err())}
                  </div>
                )}
              >
                {completion()}
              </Errored>
            </Loading>
          }
        >
          <For
            each={environments()}
            keyed={(environment) => environment.key}
            fallback={
              <SettingsRow
                title={
                  <span class="cloud-environments__empty">
                    {loading() ? (
                      t("common.loading")
                    ) : (
                      <>
                        {t("cloudWorkersPage.environments.empty")}{" "}
                        <DocsLink url="https://docs.openclaw.ai/gateway/cloud-workers">
                          {t("cloudWorkersPage.environments.docs")}
                        </DocsLink>
                      </>
                    )}
                  </span>
                }
              />
            }
          >
            {(entry) => <RepositoryRow environment={entry()} />}
          </For>
        </SettingsSection>
      </Show>
      <Show
        when={
          unlabeledImages().length || view.result?.legacyLeases.length || unlabeledBuilds().length
        }
      >
        <SettingsSection title={t("cloudWorkersPage.environments.machineImages")}>
          <For each={unlabeledImages()} keyed={(image) => image.profileKey}>
            {(image) => (
              <CloudWorkerSnapshotRow
                image={image()}
                label={image().profileId ?? image().profileKey}
                actions
                busy={presentation().image.read() || loading()}
                canCall={canCall}
                deleteReason={deleteReason}
                onMutate={mutateImage}
                onRecover={(snapshot) => void recoverCapture(snapshot)}
              />
            )}
          </For>
          <For each={unlabeledBuilds()} keyed={(worker) => worker.id}>
            {(worker) => (
              <CloudWorkerBuildRow
                environment={worker()}
                label={worker().worker?.profileId ?? worker().id}
                destroying={presentation().destroying.read()}
                canCall={canCall}
                onDestroy={(item, dismiss) => void destroyBuild(item, dismiss)}
              />
            )}
          </For>
          <For each={view.result?.legacyLeases ?? []} keyed={(lease) => lease.leaseId}>
            {(lease) => <SettingsRow title={lease().leaseId} description={lease().recoveryHint} />}
          </For>
        </SettingsSection>
      </Show>
      <CloudWorkerPoolSettings inventory={view.inventory} />
    </SettingsPage>
  );
}
