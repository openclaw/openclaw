import { createDeferred } from "@solidjs/signals";
import {
  action,
  affects,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  For,
  Loading,
  refresh,
  Show,
} from "solid-js";
import type { ProjectRecord } from "../../../../packages/gateway-protocol/src/index.js";
import { HeaderSearch } from "../../components/solid/header-search.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { isComposingKeyboardEvent, recordCompositionEnd } from "../../lib/ime.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { findBrowsableDeviceFolderHost } from "./device-placement.ts";
import type { BrowserProjectRegistration } from "./draft-place-browser.ts";
import { parentFolderDisplayName } from "./path.ts";
import { PlaceBrowser } from "./place-browser.tsx";
import { disambiguate } from "./place-labels.ts";
import { projectCloneInput } from "./project-chip.ts";
import type { ProjectChipProps } from "./project-chip.tsx";

export function ProjectPickerContent(props: ProjectChipProps) {
  const [projectSearching, setProjectSearching] = createSignal(false);
  const applyFolder = (folder: string) => {
    if (!props.params.place.browser.browserNodeId) {
      props.params.place.applyFolder(folder);
    } else if (folder) {
      // An emptied draft names no device folder; keep the current device path.
      props.params.place.selectDeviceFolder();
      props.params.place.setDeviceFolderPath(folder);
    }
  };
  const selectClone = (cloneUrl: string) =>
    props.params.place.selectRemoteProject({ identity: cloneUrl, cloneUrl });
  const newWorkspaceIcon = <Icon name="folder" />;
  const deviceFolderIcon = <Icon name="folder" />;
  const workspaceIcon = <Icon name="folder" />;
  const cloneIcon = <Icon name="gitBranch" />;
  const view = createMemo(() => {
    const folder = props.params.place.folder.trim();
    const workspace = props.params.place.workspacePath();
    const cloneInput = projectCloneInput(props.params.place.browser.projectQuery);
    const query = props.params.place.browser.projectQuery.trim();
    const browseNeedsAdmin = !props.params.place.browseAvailable() && !props.params.place.isAdmin();
    const recentItems = props.state.recents;
    const recentSuffixes = disambiguate(recentItems, (recent) => recent.displayName, [
      (recent) => (recent.kind === "folder" ? parentFolderDisplayName(recent.folder) : undefined),
      (recent) => (recent.kind === "folder" ? recent.folder : undefined),
      (recent) => (recent.kind === "folder" ? recent.folder : recent.url),
    ]);
    // Node directory listing is admin-only at the Gateway; writers type the device path.
    const place = props.params.place;
    const deviceBrowse =
      place.deviceFolderAvailable && place.isAdmin()
        ? findBrowsableDeviceFolderHost(place.deviceId, place.devices())
        : undefined;
    const deviceLabel =
      place.devices().find((device) => device.deviceId === place.deviceId)?.label ?? place.deviceId;
    const browserNodeId = place.browser.browserNodeId;
    const gatewayName = props.params.gateway.gatewayName;
    const browserLabel = browserNodeId
      ? (deviceBrowse?.label ?? browserNodeId)
      : gatewayName
        ? t("newSession.gatewayNamed", { name: gatewayName })
        : t("newSession.gateway");
    const projectSearchAvailable =
      !props.nativeTerminal &&
      canCallGatewayMethod(
        props.params.context?.gateway.snapshot,
        "projects.searchRemote",
        "operator.read",
      );
    const projectAddAvailable =
      !props.nativeTerminal &&
      readSessionMethodAccess(props.params.context?.gateway.snapshot, {
        method: "sessions.create",
        sessionScope: true,
      }).allowed;
    return {
      folder,
      workspace,
      cloneInput,
      query,
      browseNeedsAdmin,
      recentItems,
      recentSuffixes,
      deviceBrowse,
      deviceLabel,
      browserLabel,
      projectSearchAvailable,
      projectAddAvailable,
    };
  });
  const projectSource = createMemo(
    () => {
      const browser = props.params.place.browser;
      const projects = browser.projects;
      return { browser, pending: browser.projectRead, projects };
    },
    {
      equals: (previous, next) =>
        previous.browser === next.browser &&
        previous.pending === next.pending &&
        (next.pending !== null || previous.projects === next.projects),
    },
  );
  const projectsReady = createMemo(() => props.params.place.browser.projectsReady);
  const projectCatalogError = createMemo(() => props.params.place.browser.projectCatalogError);
  const projects = createDeferred<readonly ProjectRecord[]>((previous) => {
    const source = projectSource();
    // A picker mounted during a shared refresh starts with the accepted rows.
    if (previous === undefined && projectsReady()) {
      return source.projects;
    }
    return source.pending ? source.pending.then(() => source.browser.projects) : source.projects;
  });
  const browser = createMemo(() => props.params.place.browser);
  const connectionEpoch = createMemo(() => props.params.gateway.connectionEpoch);
  const registration = createMemo(() => {
    const owner = browser();
    const epoch = connectionEpoch();
    const [saving, setSaving] = createOptimistic(false);
    return { browser: owner, epoch, projects, saving, setSaving };
  });
  const presentRegistration = action(function* (
    presentation: ReturnType<typeof registration>,
    pending: Promise<void>,
    receipt: BrowserProjectRegistration,
  ) {
    if (
      presentation.browser === props.params.place.browser &&
      presentation.epoch === props.params.gateway.connectionEpoch &&
      receipt.isCurrent()
    ) {
      presentation.setSaving(true);
      affects(presentation.projects);
    }
    yield Promise.race([pending, receipt.retired]);
    if (
      presentation.browser === props.params.place.browser &&
      presentation.epoch === props.params.gateway.connectionEpoch &&
      props.params.gateway.connected &&
      presentation.browser.projectsReady &&
      presentation.browser.projectRead === null
    ) {
      // The owner already reloaded; do not rejoin a held catalog after the browser closes.
      yield refresh(presentation.projects);
    }
  });
  const registerProject = async (path: string) => {
    const presentation = registration();
    let receipt: BrowserProjectRegistration | undefined;
    const pending = presentation.browser.registerBrowserProject(path, (started) => {
      receipt = started;
    });
    if (!receipt) {
      return pending;
    }
    // Publish the admitted owner operation before joining its presentation action.
    await Promise.resolve();
    try {
      await presentRegistration(presentation, pending, receipt);
    } catch (error) {
      if (
        presentation.browser === props.params.place.browser &&
        presentation.epoch === props.params.gateway.connectionEpoch &&
        receipt.isCurrent()
      ) {
        presentation.browser.browser.error = formatUiError(error);
        props.params.onChange();
      }
    }
  };
  const localProjects = createMemo(() => {
    // Retired catalogs clear immediately; a live refresh keeps local filtering responsive.
    const accepted = !props.nativeTerminal && projectsReady() ? projects() : [];
    const query = view().query.toLowerCase().normalize("NFC");
    // Match the visible name, not shared Git owners or parent checkout directories.
    return query
      ? accepted.filter((project) =>
          project.displayName.toLowerCase().normalize("NFC").includes(query),
        )
      : accepted;
  });
  const projectSearchRead = createMemo(() => props.params.place.browser.projectSearchRead);
  const projectSearchResult = createMemo(() => {
    const read = projectSearchRead();
    return read
      ? read.completed.then((outcome) => {
          if (outcome && "error" in outcome) {
            throw outcome.error;
          }
          return outcome?.result ?? null;
        })
      : null;
  });
  const browseButton = () => (
    <button
      type="button"
      class="session-menu__item"
      data-value="browse"
      aria-pressed="false"
      aria-disabled={view().browseNeedsAdmin ? "true" : undefined}
      disabled={
        props.params.submitting ||
        props.params.pendingPlacement ||
        (!props.params.place.browseAvailable() && !view().browseNeedsAdmin)
      }
      ref={(node) => props.focus && (props.focus.browse = node)}
      onClick={() => {
        if (
          props.params.place.browseAvailable() &&
          !props.params.submitting &&
          !props.params.pendingPlacement
        ) {
          props.params.place.browser.selectGatewayBrowser(
            props.params.place.folder.trim() || view().workspace,
          );
        }
      }}
    >
      <span class="session-menu__check" aria-hidden="true" />
      <span class="session-menu__text">{t("newSession.browse")}</span>
      <span class="new-session-page__menu-chevron" aria-hidden="true">
        <Icon name="chevronRight" />
      </span>
    </button>
  );

  return (
    <>
      {props.params.place.browser.browserOpen ? (
        <PlaceBrowser
          pathRef={(node) => props.focus && (props.focus.path = node)}
          registeringProject={
            registration().saving() || props.params.place.browser.browserRegistering
          }
          params={{
            browser: props.params.place.browser.browser,
            id: "new-session-place-browser",
            label: view().browserLabel,
            registerProjectPath: props.params.place.browser.browserProjectPath,
            onBack: () => props.params.place.browser.showRoot(),
            onRegisterProject: (path) => void registerProject(path),
            onClose: () => props.params.place.browser.close(),
            onApplyFolder: applyFolder,
          }}
        />
      ) : (
        <div class="new-session-page__picker-root">
          <HeaderSearch
            title={t("newSession.projects")}
            label={t("newSession.projectSearchPlaceholder")}
            query={props.params.place.browser.projectQuery}
            open={projectSearching() || Boolean(props.params.place.browser.projectQuery)}
            disabled={props.params.submitting || props.params.pendingPlacement}
            inputProps={{ onCompositionEnd: recordCompositionEnd }}
            onOpenChange={setProjectSearching}
            onQueryChange={(query) => props.params.place.browser.changeProjectQuery(query)}
            onInputKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !isComposingKeyboardEvent(event) &&
                view().cloneInput &&
                view().projectAddAvailable
              ) {
                event.preventDefault();
                selectClone(view().cloneInput!);
              }
            }}
          />
          {props.params.place.remotePlacement && !view().query ? (
            <SessionMenuItem
              item={{
                value: "new-workspace",
                label: t("newSession.newWorkspace"),
                icon: newWorkspaceIcon,
                title: t("newSession.newWorkspaceDescription"),
                checked: props.params.place.freshWorkspace,
                onSelect: () => props.params.place.selectNewWorkspace(),
              }}
              submitting={props.params.submitting || props.params.pendingPlacement}
            />
          ) : undefined}
          {props.params.place.deviceFolderOffered && !view().query ? (
            <SessionMenuItem
              item={{
                value: "device-folder",
                label: t("newSession.deviceFolderOn", { device: view().deviceLabel }),
                icon: deviceFolderIcon,
                sub: props.params.place.deviceFolderRuntimeUnsupportedReason
                  ? t("newSession.deviceFolderModelUnsupported")
                  : undefined,
                disabled: Boolean(props.params.place.deviceFolderRuntimeUnsupportedReason),
                title:
                  props.params.place.deviceFolderRuntimeUnsupportedReason ??
                  t("newSession.deviceFolderDescription"),
                checked: Boolean(props.params.place.deviceFolder),
                // Admins pick the folder in the device browser; writers type its path.
                hasSubmenu: Boolean(view().deviceBrowse),
                keepOpen: Boolean(view().deviceBrowse),
                onSelect: () =>
                  view().deviceBrowse
                    ? props.params.place.browser.selectDeviceBrowser(
                        props.params.place.deviceId,
                        props.params.place.deviceFolder?.path.trim() || undefined,
                      )
                    : props.params.place.selectDeviceFolder(),
              }}
              submitting={props.params.submitting || props.params.pendingPlacement}
            />
          ) : undefined}
          {view().workspace && props.state.showWorkspace ? (
            <SessionMenuItem
              item={{
                value: "workspace",
                label: pathDisplayName(view().workspace),
                icon: workspaceIcon,
                checked:
                  !props.params.place.freshWorkspace &&
                  !props.params.place.browser.projectId &&
                  view().folder === view().workspace,
                onSelect: () => applyFolder(view().workspace),
              }}
              submitting={props.params.submitting}
            />
          ) : undefined}
          <Show when={projectCatalogError()}>
            <div class="new-session-page__project-error" role="alert">
              {formatUiError(projectCatalogError())}
              <button
                type="button"
                class="btn btn--sm"
                disabled={
                  props.params.submitting ||
                  props.params.pendingPlacement ||
                  props.params.place.browser.projectsLoading
                }
                onClick={() => void props.params.place.browser.refreshProjects()}
              >
                {t("common.retry")}
              </button>
            </div>
          </Show>
          <Loading on={projectsReady()}>
            <For each={localProjects()} keyed={(project) => project.id}>
              {(project) => {
                const icon = <Icon name="gitBranch" />;
                return (
                  <SessionMenuItem
                    item={{
                      value: `project:${project().id}`,
                      label: project().displayName,
                      icon,
                      checked: props.params.place.browser.projectId === project().id,
                      title: project().repoRoot,
                      onSelect: () => props.params.place.selectProjectId(project().id),
                    }}
                    submitting={props.params.submitting}
                  />
                );
              }}
            </For>
          </Loading>
          {view().cloneInput && view().projectAddAvailable ? (
            <SessionMenuItem
              item={{
                value: "project-clone-url",
                label: view().cloneInput!,
                icon: cloneIcon,
                sub: t("newSession.cloneProject"),
                checked: props.params.place.browser.remoteProject?.cloneUrl === view().cloneInput,
                onSelect: () => selectClone(view().cloneInput!),
              }}
              submitting={props.params.submitting}
            />
          ) : undefined}
          {!view().cloneInput && view().query.length >= 2 && view().projectSearchAvailable ? (
            <>
              <div class="new-session-page__menu-title">{t("newSession.githubProjects")}</div>
              <Errored
                fallback={(error) => (
                  <div class="new-session-page__project-error" role="alert">
                    {formatUiError(error())}
                  </div>
                )}
              >
                <Loading
                  on={projectSearchRead()}
                  fallback={
                    <div class="new-session-page__project-status" role="status">
                      {t("common.loading")}
                    </div>
                  }
                >
                  {projectSearchResult()?.credential === "missing" ? (
                    <div class="new-session-page__menu-note">{t("newSession.githubTokenHint")}</div>
                  ) : undefined}
                  {
                    <For
                      each={projectSearchResult()?.projects ?? []}
                      keyed={(project) => project.cloneUrl}
                    >
                      {(project) => {
                        const icon = <Icon name="gitBranch" />;
                        return (
                          <SessionMenuItem
                            item={{
                              value: `remote-project:${project().fullName}`,
                              label: project().fullName,
                              icon,
                              sub: project().description ?? t("newSession.cloneProject"),
                              checked:
                                props.params.place.browser.remoteProject?.cloneUrl ===
                                project().cloneUrl,
                              title: project().webUrl,
                              onSelect: () =>
                                props.params.place.selectRemoteProject({
                                  identity: project().fullName,
                                  cloneUrl: project().cloneUrl,
                                  ...(project().defaultBranch
                                    ? { defaultBranch: project().defaultBranch }
                                    : {}),
                                }),
                            }}
                            submitting={props.params.submitting || !view().projectAddAvailable}
                          />
                        );
                      }}
                    </For>
                  }
                </Loading>
              </Errored>
            </>
          ) : undefined}
          {(props.nativeTerminal || props.params.place.browser.projects.length === 0) &&
          props.params.place.canWrite() &&
          !props.params.place.isAdmin() ? (
            <div class="new-session-page__menu-note">{t("newSession.projectsAdminHint")}</div>
          ) : undefined}
          {props.state.recents.length > 0 ? (
            <>
              <div class="new-session-page__menu-title">{t("newSession.recentFolders")}</div>
              <For
                each={view().recentItems}
                keyed={(recent) =>
                  recent.kind === "repository"
                    ? `repository:${recent.url}`
                    : `folder:${recent.folder}`
                }
              >
                {(recent, index) => {
                  const icon = <Icon name={recent().kind === "folder" ? "folder" : "gitBranch"} />;
                  const item = createMemo(() => {
                    const row = recent();
                    return {
                      value:
                        row.kind === "repository"
                          ? `repository:${row.url}`
                          : `recent:${row.folder}`,
                      label: row.displayName,
                      icon,
                      sub: view().recentSuffixes[index()],
                      checked:
                        row.kind === "repository"
                          ? props.params.place.browser.remoteProject?.cloneUrl === row.url
                          : !props.params.place.freshWorkspace &&
                            !props.params.place.browser.projectId &&
                            view().folder === row.folder,
                      title: row.kind === "repository" ? row.url : row.folder,
                      onSelect: () => {
                        const selected = recent();
                        if (selected.kind === "repository") {
                          props.params.place.selectRemoteProject({
                            identity: selected.displayName,
                            cloneUrl: selected.url,
                          });
                        } else {
                          applyFolder(selected.folder);
                        }
                      },
                    };
                  });
                  return <SessionMenuItem item={item()} submitting={props.params.submitting} />;
                }}
              </For>
            </>
          ) : undefined}
          {view().browseNeedsAdmin ? (
            <openclaw-tooltip prop:content={t("newSession.browseRequiresAdmin")}>
              {browseButton()}
            </openclaw-tooltip>
          ) : (
            browseButton()
          )}
        </div>
      )}
    </>
  );
}
