import type WaTabGroup from "@awesome.me/webawesome/dist/components/tab-group/tab-group.js";
import type WaTab from "@awesome.me/webawesome/dist/components/tab/tab.js";
import { For, Show, createEffect, untrack } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { reclaimHubTabFocus, rememberHubTabFocus } from "../../components/hub-tabs-focus.ts";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { syncTabGroupLabel } from "../../components/web-awesome-tabs.ts";
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
import "../../styles/hub-tabs.css";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "wa-tab-group": HTMLAttributes<WaTabGroup> & {
        "prop:active": string;
        activation: "manual";
        "without-scroll-controls": boolean;
      };
      "wa-tab": HTMLAttributes<WaTab> & {
        panel: string;
        "prop:active"?: boolean;
        "prop:tabIndex": number;
      };
    }
  }
}

const WORKTREES_DOCS_URL = "https://docs.openclaw.ai/concepts/managed-worktrees";

function WorktreesContent() {
  const context = useApplication();
  return <WorktreesView model={new WorktreesModel(() => context)} />;
}

export function WorktreesView(props: { model: WorktreesModel }) {
  const model = untrack(() => props.model);
  model.gateway = useGatewayPage({
    getGateway: () => model.context.gateway,
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
  let tabGroup: WaTabGroup | undefined;
  createEffect(
    () => t("sessionsPage.hubTablistLabel"),
    (label) => syncTabGroupLabel(tabGroup, label),
  );
  const navigateSessions = (event: Event, keyboard = false) => {
    if (!(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    if (keyboard) {
      event.preventDefault();
      rememberHubTabFocus("sessions", "sessions", event.currentTarget);
    }
    model.context.navigate("sessions");
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
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header content-header--settings content-header--page hub-page-header sessions-hub-header">
          <div class="hub-page-header__title">
            <div class="page-title">{t("tabs.sessions")}</div>
            <div class="page-subtitle">
              {t("subtitles.worktrees")}{" "}
              <a
                class="learn-more-link"
                href={WORKTREES_DOCS_URL}
                target={EXTERNAL_LINK_TARGET}
                rel={buildExternalLinkRel()}
              >
                {t("common.learnMore")}
              </a>
            </div>
          </div>
          <div class="hub-page-header__tabs">
            <wa-tab-group
              class="hub-tabs hub-tabs--primary sessions-hub-tabs"
              prop:active="worktrees"
              aria-label={t("sessionsPage.hubTablistLabel")}
              activation="manual"
              without-scroll-controls
              ref={(element) => {
                tabGroup = element;
                syncTabGroupLabel(
                  element,
                  untrack(() => t("sessionsPage.hubTablistLabel")),
                );
              }}
            >
              <wa-tab
                id="sessions-tab-sessions"
                panel="sessions"
                aria-controls="sessions-hub-panel"
                class="hub-tab"
                prop:tabIndex={-1}
                aria-selected="false"
                onClick={(event) => {
                  if (event.detail > 0 || event.isTrusted) {
                    navigateSessions(event);
                  }
                }}
                onKeyDown={(event) => {
                  if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
                    navigateSessions(event, true);
                  }
                }}
              >
                {t("tabs.sessions")}
              </wa-tab>
              <wa-tab
                id="sessions-tab-worktrees"
                panel="worktrees"
                aria-controls="sessions-hub-panel"
                class="hub-tab"
                prop:active={true}
                prop:tabIndex={0}
                aria-selected="true"
                ref={(element) => reclaimHubTabFocus("sessions", "worktrees", element)}
              >
                {t("tabs.worktrees")}
              </wa-tab>
            </wa-tab-group>
          </div>
          <div class="hub-page-header__actions" />
        </section>
      </ShellLayoutBoundary>
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
