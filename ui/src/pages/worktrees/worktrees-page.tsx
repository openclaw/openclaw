import { For, Show, untrack } from "solid-js";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { WorktreesModel } from "./worktrees-model.ts";
import "../../styles/settings.css";
import "../../styles/hub-tabs.css";

const WORKTREES_DOCS_URL = "https://docs.openclaw.ai/concepts/managed-worktrees";

export function WorktreesPage() {
  const context = useApplication();
  return (
    <openclaw-worktrees-page>
      <WorktreesView model={new WorktreesModel(() => context)} />
    </openclaw-worktrees-page>
  );
}

export function WorktreesView(props: { model: WorktreesModel }) {
  // One model owns this mounted view; its Gateway context remains live.
  const model = untrack(() => props.model);
  model.gateway = useGatewayPage({
    getGateway: () => model.context.gateway,
    onIdentityChange: () => model.update({ records: [], error: null }),
    invalidateRequests: () => model.invalidateRequests(),
    ensureInitialData: () => void model.load(),
    onSnapshot: () => model.update(model.operatorAccess.canAdmin ? {} : { createOpen: false }),
  });
  const view = projectOwner(model, (source) => source).read;

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
          onClick={(event) => {
            if (!shouldHandleNavigationClick(event)) {
              return;
            }
            event.preventDefault();
            model.context.navigate(face, target.options);
          }}
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
        id="sessions"
        active="worktrees"
        tabs={[
          { value: "sessions", label: t("tabs.sessions") },
          { value: "worktrees", label: t("tabs.worktrees") },
        ]}
        ariaLabel={t("sessionsPage.hubTablistLabel")}
        panelId="sessions-hub-panel"
        docsUrl={WORKTREES_DOCS_URL}
        class="sessions-hub-header"
        onSelect={(value) => {
          if (value === "sessions") {
            model.context.navigate("sessions");
          }
        }}
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
                  disabled={!view().operatorAccess.canAdmin || view().operation === "create"}
                  onClick={() => model.toggleCreate()}
                >
                  {t("worktrees.newWorktree")}
                </button>
                <button
                  class="btn"
                  title={view().operatorAccess.canAdmin ? "" : t("worktrees.adminRequired")}
                  disabled={!view().operatorAccess.canAdmin || view().operationPending}
                  onClick={() => void model.gc()}
                >
                  {view().loading ? t("common.loading") : t("worktrees.cleanNow")}
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
                    disabled={view().operation === "create"}
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
                    disabled={view().operation === "create"}
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
                      disabled={view().operation === "create"}
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
                    disabled={view().operationPending || !view().createRepoRoot.trim()}
                    onClick={() => void model.createWorktree()}
                  >
                    {view().operation === "create" ? t("common.loading") : t("common.create")}
                  </button>
                }
              />
            </Show>
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
                        <span title={record().repoRoot}>{pathDisplayName(record().repoRoot)}</span>
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
                          title={view().operatorAccess.canAdmin ? "" : t("worktrees.adminRequired")}
                          disabled={!view().operatorAccess.canAdmin || view().operationPending}
                          onClick={() =>
                            void (record().removedAt
                              ? model.restore(record())
                              : model.removeWorktree(record()))
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
          </SettingsSection>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}
