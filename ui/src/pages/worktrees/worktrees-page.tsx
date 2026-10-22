import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  For,
  latest,
  Loading,
  Show,
} from "solid-js";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { sessionHubTabs } from "../sessions/session-hub-tabs.ts";
import { WorktreesModel } from "./worktrees-model.ts";
import "../../styles/settings.css";
import "../../styles/hub-tabs.css";

const WORKTREES_DOCS_URL = "https://docs.openclaw.ai/concepts/managed-worktrees";

export function WorktreesPage() {
  const context = useApplication();
  const { owner, view } = projectCallbackOwner(
    (notify) => new WorktreesModel(() => context, notify),
    (model) => model,
  );
  return <openclaw-worktrees-page>{renderWorktreesView(owner, view.read)}</openclaw-worktrees-page>;
}

export function renderWorktreesView(model: WorktreesModel, view: () => WorktreesModel) {
  model.gateway = useGatewayPage({
    getGateway: () => model.context.gateway,
    onIdentityChange: () => model.update({ records: [], listLoaded: false, error: null }),
    invalidateRequests: () => model.invalidateRequests(),
    ensureInitialData: () => void model.load(),
    onSnapshot: () => model.update(model.operatorAccess.canAdmin ? {} : { createOpen: false }),
  });

  const receipt = createMemo(() => view().listRead);
  const listRead = createMemo(() =>
    receipt().result.then(() => {
      if (!model.listLoaded && model.error) {
        throw new Error(model.error);
      }
    }),
  );
  const scope = createMemo(() => model.gateway.epoch);
  const pending = createMemo(() => {
    const epoch = scope();
    const [operation, setOperation] = createOptimistic<WorktreesModel["operation"]>(null);
    return { epoch, operation, setOperation };
  });
  const present = action(function* (
    captured: ReturnType<typeof pending>,
    operation: WorktreesModel["operation"],
    result: Promise<void>,
    retired: Promise<void>,
  ) {
    try {
      if (captured.epoch === model.gateway.readEpoch()) {
        captured.setOperation(operation);
      }
      yield Promise.race([result, retired]);
    } catch (error) {
      if (captured.epoch === model.gateway.readEpoch()) {
        model.update({ error: formatUiError(error) });
      }
    }
  });
  async function mutate(operation: WorktreesModel["operation"], task: () => Promise<void>) {
    const captured = pending();
    const retired = model.retired;
    const result = task();
    // Admission publishes synchronously before the optimistic presentation joins.
    await Promise.resolve();
    return present(captured, operation, result, retired);
  }
  const operation = () => pending().operation() ?? view().operation;
  const busy = () => operation() !== null || view().operationPending;
  const readList = () => {
    latest(listRead);
    return null;
  };

  const owner = (record: WorktreesModel["records"][number]) => {
    if (record.ownerKind === "session" && record.ownerId) {
      const face = resolveSessionPreferredFaceForKey(model.context, record.ownerId);
      const target = sessionNavigationTarget({
        context: model.context,
        face,
        sessionKey: record.ownerId,
        preferenceDerivedFace: true,
      });
      return (
        <a
          href={target.href}
          title={record.ownerId}
          onClick={(event) =>
            handleNavigationClick(event, () => model.context.navigate(face, target.options))
          }
        >
          {t("worktrees.ownerSession")}
        </a>
      );
    }
    return record.ownerKind === "workboard" ? (
      <span title={record.ownerId ?? ""}>{t("worktrees.ownerWorkboard")}</span>
    ) : (
      <span>{t("worktrees.ownerManual")}</span>
    );
  };

  return (
    <>
      <HubPageHeader<"sessions" | "worktrees">
        active="worktrees"
        tabs={sessionHubTabs("worktrees", (tab) => model.context.navigate(tab))}
        docsUrl={WORKTREES_DOCS_URL}
        class="sessions-hub-header"
      />
      <SettingsWorkspace id="sessions-hub-panel">
        <SettingsPage wide>
          <Show when={!view().operatorAccess.canAdmin}>
            <div class="callout info" role="note">
              {t("worktrees.adminRequired")}
            </div>
          </Show>
          <Show when={view().error}>
            <div class="callout danger" role="alert">
              {view().error}
            </div>
          </Show>
          <SettingsSection
            title={t("worktrees.title")}
            description={t("worktrees.subtitle")}
            actions={
              <>
                <button
                  class="btn"
                  title={view().operatorAccess.canAdmin ? "" : t("worktrees.adminRequired")}
                  aria-expanded={view().createOpen ? "true" : "false"}
                  disabled={!view().operatorAccess.canAdmin || operation() === "create"}
                  onClick={() => model.toggleCreate()}
                >
                  {t("worktrees.newWorktree")}
                </button>
                <button
                  class="btn"
                  title={view().operatorAccess.canAdmin ? "" : t("worktrees.adminRequired")}
                  disabled={!model.gateway.connected || !view().operatorAccess.canAdmin || busy()}
                  onClick={() => void mutate("gc", () => model.gc())}
                >
                  {operation() === "gc" || view().loading
                    ? t("common.loading")
                    : t("worktrees.cleanNow")}
                </button>
              </>
            }
          >
            <Show when={view().createOpen}>
              <SettingsRow
                title={t("worktrees.repo")}
                control={
                  <input
                    class="settings-input"
                    type="text"
                    aria-label={t("worktrees.repo")}
                    disabled={operation() === "create"}
                    value={view().createRepoRoot}
                    onInput={(event) => model.update({ createRepoRoot: event.currentTarget.value })}
                    onChange={(event) => {
                      model.update({
                        createRepoRoot: event.currentTarget.value,
                        createBaseRef: "",
                      });
                      void model.loadCreateBranches();
                    }}
                  />
                }
              />
              <SettingsRow
                title={t("worktrees.name")}
                control={
                  <input
                    class="settings-input"
                    type="text"
                    aria-label={t("worktrees.name")}
                    disabled={operation() === "create"}
                    placeholder={t("worktrees.namePlaceholder")}
                    value={view().createName}
                    onInput={(event) => model.update({ createName: event.currentTarget.value })}
                  />
                }
              />
              <SettingsRow
                title={t("worktrees.baseBranch")}
                control={
                  <>
                    <input
                      class="settings-input"
                      type="text"
                      aria-label={t("worktrees.baseBranch")}
                      disabled={operation() === "create"}
                      placeholder={t("worktrees.baseBranchPlaceholder")}
                      list="worktrees-create-branches"
                      value={view().createBaseRef}
                      onInput={(event) =>
                        model.update({ createBaseRef: event.currentTarget.value })
                      }
                    />
                    <datalist id="worktrees-create-branches">
                      <For each={view().createBranches}>{(name) => <option value={name} />}</For>
                    </datalist>
                  </>
                }
              />
              <SettingsRow
                title={t("worktrees.newWorktree")}
                control={
                  <button
                    class="btn btn--sm"
                    disabled={!model.gateway.connected || busy() || !view().createRepoRoot.trim()}
                    onClick={() => void mutate("create", () => model.createWorktree())}
                  >
                    {operation() === "create" ? t("common.loading") : t("common.create")}
                  </button>
                }
              />
            </Show>
            <Errored
              fallback={(_error, reset) => (
                <button
                  class="btn"
                  onClick={() => {
                    void model.load();
                    reset();
                  }}
                >
                  {t("common.retry")}
                </button>
              )}
            >
              <Loading
                on={latest(scope)}
                fallback={<SettingsEmpty message={t("common.loading")} />}
              >
                {readList()}
                <Show
                  when={view().records.length > 0}
                  fallback={<SettingsEmpty message={t("worktrees.empty")} />}
                >
                  <For each={view().records} keyed={(record) => record.id}>
                    {(record) => (
                      <SettingsRow
                        title={record().name}
                        description={
                          <>
                            <span title={record().repoRoot}>
                              {pathDisplayName(record().repoRoot)}
                            </span>
                            {" · "}
                            {record().branch}
                            {" · "}
                            {owner(record())}
                            {" · "}
                            {formatRelativeTimestamp(record().lastActiveAt)}
                          </>
                        }
                        control={
                          <>
                            <SettingsStatus
                              kind={record().removedAt ? "muted" : "ok"}
                              label={
                                record().removedAt ? t("worktrees.restorable") : t("common.active")
                              }
                            />
                            <button
                              class={["btn btn--sm", { danger: !record().removedAt }]}
                              title={
                                view().operatorAccess.canAdmin ? "" : t("worktrees.adminRequired")
                              }
                              aria-label={`${record().removedAt ? t("worktrees.restore") : t("common.delete")}: ${record().name}`}
                              disabled={
                                !model.gateway.connected ||
                                !view().operatorAccess.canAdmin ||
                                busy()
                              }
                              onClick={() =>
                                void mutate("row", () =>
                                  record().removedAt
                                    ? model.restore(record())
                                    : model.removeWorktree(record()),
                                )
                              }
                            >
                              {record().removedAt ? t("worktrees.restore") : t("common.delete")}
                            </button>
                          </>
                        }
                      />
                    )}
                  </For>
                </Show>
              </Loading>
            </Errored>
          </SettingsSection>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}
