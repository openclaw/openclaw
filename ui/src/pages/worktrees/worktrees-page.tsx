import { html, nothing, render as renderLit } from "lit";
import { For, Show, createEffect, onCleanup, untrack } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { renderSessionsHubHeader } from "../../components/sessions-hub-header.ts";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import {
  resolveSessionPreferredFaceForKey,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { WorktreesModel } from "./worktrees-model.ts";
import "../../styles/settings.css";

const WORKTREES_DOCS_URL = "https://docs.openclaw.ai/concepts/managed-worktrees";

function WorktreesContent() {
  const context = useApplication();
  return <WorktreesView model={new WorktreesModel(() => context)} />;
}

export function WorktreesView(props: { model: WorktreesModel }) {
  const model = untrack(() => props.model);
  model.gateway = useGatewayPage(() => model.context, {
    onIdentityChange: () => model.update({ records: [], error: null }),
    invalidateRequests: () => model.invalidateRequests(),
    ensureInitialData: () => void model.load(),
    onSnapshot: () => model.update(model.operatorAccess.canAdmin ? {} : { createOpen: false }),
  });
  const projection = projectSource(model, {
    read: (source) => source,
    subscribe: (source, notify) => source.subscribe(notify),
    equality: "revision",
  });
  const view = projection.read;
  // Lit owns the shared tab strip's descendants; Solid inserts its existing roots
  // without a wrapper so the header/workspace sibling selectors keep matching.
  const headerContainer = document.createDocumentFragment();
  const headerEnd = document.createComment("");
  headerContainer.append(headerEnd);
  const headerOptions = { renderBefore: headerEnd };
  const renderHeader = () =>
    renderSessionsHubHeader({
      active: "worktrees",
      title: titleForRoute("sessions"),
      subtitle: html`${subtitleForRoute("worktrees")}
        <a
          class="learn-more-link"
          href=${WORKTREES_DOCS_URL}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
          >${t("common.learnMore")}</a
        >`,
      onSelect: (tab) => {
        if (tab !== "worktrees") {
          model.context.navigate(tab);
        }
      },
    });
  const headerPart = renderLit(untrack(renderHeader), headerContainer, headerOptions);
  const headerNodes = Array.from(headerContainer.childNodes);
  createEffect(renderHeader, (template) => {
    renderLit(template, headerContainer, headerOptions);
  });
  onCleanup(() => {
    headerPart.setConnected(false);
    renderLit(nothing, headerContainer, headerOptions);
  });

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
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>{headerNodes}</ShellLayoutBoundary>
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
                          class={record().removedAt ? "btn btn--sm" : "btn btn--sm danger"}
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

export const WorktreesPage = defineSolidBridge("openclaw-worktrees-page", WorktreesContent, {
  properties: {},
});
