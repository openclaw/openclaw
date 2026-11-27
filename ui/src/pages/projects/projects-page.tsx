import { createMemo, Errored, For, latest, Loading, onSettled, Show } from "solid-js";
import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { foldSearchCase } from "../../../../src/shared/search-case.js";
import "../../components/modal-dialog.tsx";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import {
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { Switch } from "../../components/solid/switch.tsx";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { projectCallbackOwner } from "../../lib/reactive/callback-owner.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { PlaceBrowser } from "../new-session/place-browser.tsx";
import { sessionHubTabs, type SessionHubTab } from "../sessions/session-hub-tabs.ts";
import "../../styles/settings.css";
import "../../styles/hub-tabs.css";
import "../../styles/new-session.css";
import {
  readConfiguredRoles,
  roleProjectAccess,
  type ConfiguredRole,
  type RoleProjectAccess,
} from "./project-access.ts";
import { ProjectsModel } from "./projects-model.ts";

const PROJECTS_DOCS_URL =
  "https://docs.openclaw.ai/web/control-ui/sessions-and-sidebar#projects-tab";

export const projectsRouteView = {
  renderSolid: () => (
    <ShellLayoutBoundary
      traits={{ settingsPage: true, settingsWide: true, settingsWorkspace: true }}
    >
      <ProjectsPage />
    </ShellLayoutBoundary>
  ),
};

export function ProjectsPage() {
  const context = useApplication();
  const { owner, view } = projectCallbackOwner(
    (notify) => new ProjectsModel(() => context, notify),
    (model) => model,
  );
  return <openclaw-projects-page>{renderProjectsView(owner, view.read)}</openclaw-projects-page>;
}

function projectType(project: ProjectRecord) {
  return project.source === "workspace"
    ? t("projectsPage.typeWorkspace")
    : project.source === "cloned"
      ? t("projectsPage.typeClone")
      : t("projectsPage.typeCheckout");
}

function accessReason(access: RoleProjectAccess) {
  switch (access.reason) {
    case "admin":
      return t("projectsPage.accessAdmin");
    case "write":
      return t("projectsPage.accessWrite");
    case "all":
      return t("projectsPage.accessAll");
    case "no-sessions":
      return t("projectsPage.accessNoSessions");
    case "agents":
      return t("projectsPage.accessAgents");
    default:
      return undefined;
  }
}

export function renderProjectsView(model: ProjectsModel, view: () => ProjectsModel) {
  model.gateway = useGatewayPage({
    getGateway: () => model.context.gateway,
    onIdentityChange: () =>
      model.update({ records: [], listLoaded: false, error: null, selectedId: null }),
    invalidateRequests: () => model.invalidateRequests(),
    ensureInitialData: () => void model.load(),
  });
  const runtimeConfig = projectRuntimeConfig(model.context.runtimeConfig);
  onSettled(() => {
    void model.context.runtimeConfig.ensureDisplayLoaded();
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
  const canAdmin = () => view().operatorAccess.canAdmin;
  const busy = () => view().operation !== null;
  /** `undefined` until the configuration is readable; `null` when named roles aren't configured. */
  const roles = createMemo<ConfiguredRole[] | null | undefined>(() => {
    const snapshot = runtimeConfig.read().state.configSnapshot;
    return snapshot ? readConfiguredRoles(resolveEditableSnapshotConfig(snapshot)) : undefined;
  });
  const filtered = createMemo(() => {
    const query = foldSearchCase(view().query.trim().normalize("NFC"));
    const records = view().records;
    return query
      ? records.filter((project) =>
          [project.displayName, project.repositoryIdentity, project.repoRoot].some((value) =>
            value ? foldSearchCase(value.normalize("NFC")).includes(query) : false,
          ),
        )
      : records;
  });
  const accessFor = (project: ProjectRecord) => {
    const configured = roles();
    if (!configured) {
      return configured;
    }
    const pending = view().pendingAccess;
    return configured.map((role) => {
      const access = roleProjectAccess(role, project);
      if (pending && pending.role === role.name && pending.projectId === project.id) {
        access.enabled = pending.enabled;
      }
      return access;
    });
  };

  const AccessChips = (props: { project: ProjectRecord }) => {
    const access = createMemo(() => accessFor(props.project));
    return (
      <Show when={access() !== undefined} fallback={<span class="muted">—</span>}>
        <Show
          when={access()}
          fallback={<span class="muted">{t("projectsPage.accessEveryone")}</span>}
        >
          {(entries) => (
            <span class="chip-row">
              <For each={entries().filter((entry) => entry.enabled)} keyed={(entry) => entry.role}>
                {(entry) => <span class="chip">{entry().role}</span>}
              </For>
            </span>
          )}
        </Show>
      </Show>
    );
  };

  const RegisterMenu = () => (
    <Menu
      id="projects-register"
      lazy
      label={t("projectsPage.register")}
      placement="bottom-end"
      triggerClass="btn"
      trigger={
        <>
          {t("projectsPage.register")}
          <Icon name="chevronDown" />
        </>
      }
      disabled={!model.gateway.connected || busy()}
      items={[
        { id: "browse", label: t("projectsPage.registerBrowse"), icon: <Icon name="folder" /> },
        ...(view().canClone
          ? [{ id: "clone", label: t("projectsPage.registerClone"), icon: <Icon name="github" /> }]
          : []),
      ]}
      onSelect={(item) => {
        if (item.id === "browse") {
          model.openBrowser();
        } else if (item.id === "clone") {
          void model.cloneFromGitHub();
        }
      }}
    />
  );

  return (
    <>
      <HubPageHeader<SessionHubTab>
        active="projects"
        tabs={sessionHubTabs("projects", (tab) => model.context.navigate(tab))}
        docsUrl={PROJECTS_DOCS_URL}
        class="sessions-hub-header"
        actions={
          <Show when={canAdmin()}>
            <RegisterMenu />
          </Show>
        }
      />
      <SettingsWorkspace id="sessions-hub-panel">
        <SettingsPage wide>
          <Show when={!canAdmin()}>
            <InlineAlert tone="info" role="note">
              {t("projectsPage.adminRequired")}
            </InlineAlert>
          </Show>
          <Show when={!view().selectedId && view().error}>
            <InlineAlert tone="danger" role="alert">
              {view().error}
            </InlineAlert>
          </Show>
          <SettingsSection
            notice={
              <div class="data-table-search">
                <input
                  type="search"
                  aria-label={t("projectsPage.search")}
                  placeholder={t("projectsPage.search")}
                  value={view().query}
                  onInput={(event) => model.update({ query: event.currentTarget.value })}
                />
              </div>
            }
          >
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
                {(latest(listRead), null)}
                <Show
                  when={filtered().length > 0}
                  fallback={
                    <SettingsEmpty
                      message={
                        view().records.length > 0
                          ? t("projectsPage.noMatches")
                          : t("projectsPage.empty")
                      }
                    />
                  }
                >
                  <div class="data-table-container">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>{t("projectsPage.columnProject")}</th>
                          <th>{t("projectsPage.columnType")}</th>
                          <th>{t("projectsPage.columnLocation")}</th>
                          <th>{t("projectsPage.columnAccess")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={filtered()} keyed={(project) => project.id}>
                          {(project) => (
                            <tr
                              tabindex="0"
                              onClick={() => model.select(project().id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  model.select(project().id);
                                }
                              }}
                            >
                              <td>
                                <div>{project().displayName}</div>
                                <Show when={project().repositoryIdentity}>
                                  {(identity) => <div class="muted">{identity()}</div>}
                                </Show>
                              </td>
                              <td>{projectType(project())}</td>
                              <td>
                                <Show
                                  when={project().repoRoot}
                                  fallback={<span class="muted">—</span>}
                                >
                                  {(root) => <span class="mono">{root()}</span>}
                                </Show>
                              </td>
                              <td>
                                <AccessChips project={project()} />
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </Loading>
            </Errored>
          </SettingsSection>
        </SettingsPage>
      </SettingsWorkspace>
      <Show when={view().selected}>
        {(project) => (
          <ProjectDetails
            model={model}
            view={view}
            project={project()}
            access={accessFor(project())}
          />
        )}
      </Show>
      <Show when={view().browserOpen}>
        <openclaw-modal-dialog
          label={t("projectsPage.browseTitle")}
          style={{ "--openclaw-modal-width": "560px" }}
          onModal-cancel={(event: Event) => {
            event.preventDefault();
            model.closeBrowser();
          }}
        >
          <div class="oc-dialog projects-browse">
            {/* The folder browser carries its own close control. */}
            <DialogHeader title={t("projectsPage.browseTitle")} />
            <div class="oc-dialog__body">
              <PlaceBrowser
                registeringProject={view().operation === "register"}
                params={{
                  browser: view().browser,
                  id: "projects-place-browser",
                  label: t("projectsPage.browseLabel"),
                  registerProjectPath: null,
                  onBack: () => model.closeBrowser(),
                  onRegisterProject: () => undefined,
                  onClose: () => model.closeBrowser(),
                  onApplyFolder: (path) => void model.registerFolder(path),
                }}
              />
            </div>
          </div>
        </openclaw-modal-dialog>
      </Show>
    </>
  );
}

function ProjectDetails(props: {
  model: ProjectsModel;
  view: () => ProjectsModel;
  project: ProjectRecord;
  access: RoleProjectAccess[] | null | undefined;
}) {
  const canAdmin = () => props.view().operatorAccess.canAdmin;
  const workspace = () => props.project.source === "workspace";
  const readOnly = () => props.model.context.config.current.readOnlyConfig;
  const facts = createMemo(() =>
    [
      [t("projectsPage.sourceType"), projectType(props.project)],
      [t("projectsPage.sourceRepository"), props.project.repositoryIdentity],
      [t("projectsPage.sourceOrigin"), props.project.originUrl],
      [t("projectsPage.sourceLocation"), props.project.repoRoot],
      [t("projectsPage.sourceAgent"), props.project.agentId],
      [t("projectsPage.sourceId"), props.project.id],
    ].filter((fact): fact is [string, string] => Boolean(fact[1])),
  );
  return (
    <openclaw-modal-dialog
      label={props.project.displayName}
      style={{ "--openclaw-modal-width": "620px" }}
      onModal-cancel={(event: Event) => {
        event.preventDefault();
        props.model.select(null);
      }}
    >
      <div class="oc-dialog projects-detail">
        <DialogHeader title={props.project.displayName} onClose={() => props.model.select(null)} />
        <div class="oc-dialog__body">
          <Show when={props.view().error}>
            <InlineAlert tone="danger" role="alert">
              {props.view().error}
            </InlineAlert>
          </Show>
          <SettingsSection title={t("projectsPage.sourceHeading")}>
            <For each={facts()} keyed={false}>
              {(fact) => (
                <SettingsRow title={fact()[0]} control={<SettingsValue value={fact()[1]} />} />
              )}
            </For>
          </SettingsSection>
          <SettingsSection
            title={t("projectsPage.accessHeading")}
            notice={
              <>
                <Show when={readOnly()}>
                  {(notice) => (
                    <InlineAlert tone="info" role="note">
                      <strong>{t("nav.gateway.configReadOnly")}</strong>{" "}
                      {notice().message || t("nav.gateway.configReadOnlyHint")}
                    </InlineAlert>
                  )}
                </Show>
                <Show when={!canAdmin()}>
                  <span class="muted">{t("projectsPage.accessAdminRequired")}</span>
                </Show>
                <Show when={workspace()}>
                  <span class="muted">{t("projectsPage.accessAgentsNote")}</span>
                </Show>
              </>
            }
          >
            <Show
              when={props.access !== undefined}
              fallback={<SettingsEmpty message={t("projectsPage.accessUnavailable")} />}
            >
              <Show
                when={props.access}
                fallback={<SettingsEmpty message={t("projectsPage.accessNoRoles")} />}
              >
                {(entries) => (
                  <>
                    <For each={entries()} keyed={(entry) => entry.role}>
                      {(entry) => (
                        <SettingsRow
                          title={entry().role}
                          description={accessReason(entry())}
                          control={
                            <Switch
                              ariaLabel={entry().role}
                              checked={entry().enabled}
                              disabled={entry().reason !== null || !props.view().canEditAccess}
                              saving={props.view().operation !== null}
                              onChange={(enabled) =>
                                void props.model.setRoleAccess(entry().role, props.project, enabled)
                              }
                            />
                          }
                        />
                      )}
                    </For>
                  </>
                )}
              </Show>
            </Show>
          </SettingsSection>
          <span class="muted">{t("projectsPage.accessPublicNote")}</span>
          <span class="muted">{t("projectsPage.accessWorktreeNote")}</span>
        </div>
        <Show when={canAdmin() && !workspace()}>
          <openclaw-modal-actions class="oc-dialog__footer">
            <button
              type="button"
              class="btn danger"
              disabled={!props.model.gateway.connected || props.view().operation !== null}
              onClick={() => void props.model.remove(props.project)}
            >
              {t("projectsPage.remove")}
            </button>
            <button
              type="button"
              class="btn"
              disabled={!props.model.gateway.connected || props.view().operation !== null}
              onClick={() => void props.model.rename(props.project)}
            >
              {t("projectsPage.rename")}
            </button>
          </openclaw-modal-actions>
        </Show>
      </div>
    </openclaw-modal-dialog>
  );
}
