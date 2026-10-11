import { createMemo, createStore, For, Show, onCleanup } from "solid-js";
import type {
  EnvironmentSummary,
  EnvironmentsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsSummary,
} from "../../components/solid/settings-ui.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";

registerEnglishCatalog(registerSettingsEnglish);

type PoolState = "ready" | "preparing" | "releasing" | "attention";
type Preparation = NonNullable<EnvironmentSummary["preparation"]>;
type PreparedEnvironment = EnvironmentSummary & {
  preparation: Preparation & { details: NonNullable<Preparation["details"]> };
  worker: NonNullable<EnvironmentSummary["worker"]>;
};

function poolState(environment: PreparedEnvironment, now: number): PoolState {
  const worker = environment.worker;
  if (environment.status === "error") {
    return "attention";
  }
  if (worker.destroyRequestedAtMs !== undefined || environment.status === "stopping") {
    return "releasing";
  }
  if (environment.preparation.details.expiresAtMs <= now || environment.status === "unavailable") {
    return "attention";
  }
  if (worker.state === "ready") {
    return "ready";
  }
  return environment.status === "starting" ? "preparing" : "attention";
}

export const CloudWorkerPool = defineSolidBridge(
  "openclaw-cloud-worker-pool",
  () => {
    const context = useApplication();
    const [view, setView] = createStore<{
      result: EnvironmentsListResult | null;
      error: string | null;
      updatedAt: number | null;
      request: AbortController | undefined;
    }>({ result: null, error: null, updatedAt: null, request: undefined });

    let request: AbortController | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let polling = false;
    function stopPolling() {
      polling = false;
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    function startPolling() {
      polling = true;
      resumePolling();
    }
    function resumePolling() {
      clearInterval(pollTimer);
      pollTimer = undefined;
      if (polling && document.visibilityState !== "hidden") {
        pollTimer = setInterval(() => void load(), 10_000);
      }
    }
    onCleanup(stopPolling);

    const gateway = useGatewayPage({
      getGateway: () => context.gateway,
      invalidateRequests: () => {
        request?.abort();
        request = undefined;
        setView((draft) => {
          draft.request = undefined;
        });
        stopPolling();
        setView((draft) => {
          draft.result = null;
          draft.error = null;
          draft.updatedAt = null;
        });
      },
      ensureInitialData: () => {
        if (canRead()) {
          startPolling();
          void load();
        }
      },
      onPageActivation: () => {
        resumePolling();
        void load();
      },
    });

    function canRead() {
      return canCallGatewayMethod(gateway.snapshot, "environments.list", "operator.admin");
    }

    function loading() {
      return view.request !== undefined;
    }

    async function load() {
      const scope = gateway.capture();
      if (!scope || !canRead() || request || document.visibilityState === "hidden") {
        return;
      }
      const activeRequest = new AbortController();
      request = activeRequest;
      setView((draft) => {
        draft.request = activeRequest;
      });
      try {
        const result = await scope.client.request<EnvironmentsListResult>(
          "environments.list",
          { includePreparedDetails: true },
          { signal: activeRequest.signal },
        );
        if (gateway.isCurrent(scope)) {
          setView((draft) => {
            draft.result = result;
            draft.error = null;
            draft.updatedAt = Date.now();
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
          request = undefined;
          setView((draft) => {
            draft.request = undefined;
          });
        }
      }
    }

    function renderWorker(environment: PreparedEnvironment, now: number) {
      const { worker, preparation } = environment;
      const { details } = preparation;
      const category = poolState(environment, now);
      const expired = details.expiresAtMs <= now;
      const label =
        category === "releasing"
          ? t("cloudWorkersPage.pool.releasing")
          : worker.state === "failed" || worker.state === "orphaned"
            ? t(`cloudWorkersPage.snapshots.buildStates.${worker.state}`)
            : expired
              ? t("cloudWorkersPage.pool.expired")
              : category === "attention"
                ? t("cloudWorkersPage.pool.unavailable")
                : t(`cloudWorkersPage.pool.${category}`);
      return (
        <SettingsRow
          title={details.project?.label ?? t("cloudWorkersPage.pool.unknownProject")}
          description={
            <>
              {details.project?.baseCommit ? (
                <>
                  <code>{details.project.baseCommit.slice(0, 8)}</code> ·{" "}
                </>
              ) : null}
              {t(`cloudWorkersPage.pool.${preparation.purpose}`)} ·
              {t("cloudWorkersPage.pool.age", { age: formatDurationHuman(worker.ageMs) })}
              <br />
              <time datetime={new Date(details.expiresAtMs).toISOString()}>
                {t(
                  expired ? "cloudWorkersPage.pool.expiredAt" : "cloudWorkersPage.pool.expiresAt",
                  {
                    time: formatRelativeTimestamp(details.expiresAtMs),
                  },
                )}
              </time>
              {worker.error ? (
                <>
                  <br />
                  <span>{worker.error}</span>
                </>
              ) : null}
            </>
          }
          stackedOnNarrow
          control={
            <SettingsStatus
              kind={category === "ready" ? "ok" : category === "attention" ? "warn" : "accent"}
              label={label}
            />
          }
        />
      );
    }

    const inventory = createMemo(() => {
      const now = Date.now();
      const pool = view.result?.preparedPool;
      const reserved = new Set(pool?.reservedEnvironmentIds);
      const rows = (view.result?.environments ?? []).filter(
        (environment): environment is PreparedEnvironment =>
          environment.preparation?.details !== undefined &&
          environment.worker !== undefined &&
          environment.worker.state !== "destroyed" &&
          (reserved.has(environment.id) ||
            (environment.preparation.details.consumedAtMs === null &&
              environment.worker.attachedSessionIds.length === 0)),
      );
      const groups = new Map<string, PreparedEnvironment[]>();
      for (const row of rows) {
        const profileId = row.worker.profileId ?? "";
        const group = groups.get(profileId) ?? [];
        group.push(row);
        groups.set(profileId, group);
      }
      return { now, pool, reserved, rows, groups };
    });
    const capacity = createMemo(() => {
      const pool = inventory().pool;
      return pool
        ? pool.maxTotal === 0
          ? t("cloudWorkersPage.pool.disabledCapacity", {
              count: String(inventory().reserved.size),
            })
          : t("cloudWorkersPage.pool.capacity", {
              used: String(inventory().reserved.size),
              limit: String(pool.maxTotal),
            })
        : t(loading() ? "common.loading" : "cloudWorkersPage.pool.inventoryUnavailable");
    });
    return (
      <SettingsPage>
        <Show
          when={gateway.connected}
          fallback={<SettingsEmpty message={t("cloudWorkersPage.pool.offline")} />}
        >
          <Show
            when={canRead()}
            fallback={<SettingsEmpty message={t("cloudWorkersPage.pool.adminRequired")} />}
          >
            <>
              <SettingsSection
                title={t("cloudWorkersPage.pool.title")}
                description={t("cloudWorkersPage.pool.description")}
                actions={
                  <button
                    class="btn btn--sm"
                    type="button"
                    disabled={loading()}
                    onClick={() => void load()}
                  >
                    {t("common.refresh")}
                  </button>
                }
                notice={
                  view.error ? (
                    <div class="callout warning" role="alert">
                      {t("cloudWorkersPage.pool.refreshFailed", { error: view.error })}{" "}
                      {view.updatedAt !== null
                        ? t("cloudWorkersPage.pool.lastUpdated", {
                            time: formatRelativeTimestamp(view.updatedAt),
                          })
                        : null}
                    </div>
                  ) : null
                }
              >
                <SettingsRow
                  title={capacity()}
                  description={
                    inventory().pool?.maxTotal === 0
                      ? t("cloudWorkersPage.pool.disabled")
                      : t("cloudWorkersPage.pool.capacityHelp")
                  }
                />
              </SettingsSection>
              {inventory().pool ? (
                <SettingsSummary
                  items={(["ready", "preparing", "releasing", "attention"] as const).map(
                    (category) => ({
                      label: t(`cloudWorkersPage.pool.${category}`),
                      value: inventory().rows.filter(
                        (row) => poolState(row, inventory().now) === category,
                      ).length,
                    }),
                  )}
                />
              ) : null}
              <For
                each={[...inventory().groups].toSorted(([a], [b]) => a.localeCompare(b))}
                keyed={(entry) => entry[0]}
              >
                {(entry) => {
                  const profileId = () => entry()[0];
                  const workers = () => entry()[1];
                  const profile = () =>
                    view.result?.profiles?.find((item) => item.id === profileId());
                  const targetDescription = () => {
                    const readyWorkers = profile()?.readyWorkers;
                    return readyWorkers === undefined
                      ? undefined
                      : t("cloudWorkersPage.pool.target", { count: String(readyWorkers) });
                  };
                  return (
                    <SettingsSection
                      title={profileId() || t("cloudWorkersPage.snapshots.unlabeledProfile")}
                      description={targetDescription()}
                      count={workers().length}
                    >
                      <For each={workers()} keyed={(worker) => worker.id}>
                        {(worker) => <>{renderWorker(worker(), inventory().now)}</>}
                      </For>
                    </SettingsSection>
                  );
                }}
              </For>
              {inventory().pool && inventory().rows.length === 0 ? (
                <SettingsEmpty message={t("cloudWorkersPage.pool.empty")} />
              ) : null}
            </>
          </Show>
        </Show>
      </SettingsPage>
    );
  },
  { properties: {} },
);
