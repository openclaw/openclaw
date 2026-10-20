import { createMemo, For, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { findBrowsableDeviceFolderHost } from "./device-placement.ts";
import type { ProjectBrowserFocus } from "./draft-place-browser.ts";
import { parentFolderDisplayName } from "./path.ts";
import { SessionPicker } from "./picker.tsx";
import { PlaceBrowser } from "./place-browser.tsx";
import { disambiguate } from "./place-labels.ts";
import { projectCloneInput, type resolveProjectChip } from "./project-chip.ts";
import type { NewSessionPlaceControlsOptions } from "./target-controls.ts";
export function ProjectChip(props: {
  params: NewSessionPlaceControlsOptions;
  state: ReturnType<typeof resolveProjectChip>;
  nativeTerminal: boolean;
  focus?: ProjectBrowserFocus;
}) {
  const label = () =>
    props.params.place.deviceFolder ? t("newSession.deviceFolder") : props.state.label;
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
  const triggerIcon = <Icon name={props.params.place.browser.projectId ? "gitBranch" : "folder"} />;
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
      browserLabel,
      projectSearchAvailable,
      projectAddAvailable,
    };
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
    <SessionPicker
      kind="project"
      label={`${t("newSession.what")}: ${label()}`}
      value={label()}
      icon={triggerIcon}
      triggerAttributes={{ "data-project-id": props.params.place.browser.projectId || undefined }}
      params={props.params}
    >
      {props.params.place.browser.browserOpen ? (
        <PlaceBrowser
          pathRef={(node) => props.focus && (props.focus.path = node)}
          params={{
            browser: props.params.place.browser.browser,
            id: "new-session-place-browser",
            label: view().browserLabel,
            registerProjectPath: props.params.place.browser.browserProjectPath,
            registeringProject: props.params.place.browser.browserRegistering,
            onBack: () => props.params.place.browser.showRoot(),
            onRegisterProject: (path) =>
              void props.params.place.browser.registerBrowserProject(path),
            onClose: () => props.params.place.browser.close(),
            onApplyFolder: applyFolder,
          }}
        />
      ) : (
        <div class="new-session-page__picker-root">
          <div class="new-session-page__menu-title">{t("newSession.projects")}</div>
          {props.params.place.remotePlacement && !view().query ? (
            <SessionMenuItem
              item={{
                value: "new-workspace",
                label: t("newSession.newWorkspace"),
                icon: newWorkspaceIcon,
                sub: t("newSession.newWorkspaceDescription"),
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
                label: t("newSession.deviceFolder"),
                icon: deviceFolderIcon,
                sub:
                  props.params.place.deviceFolderRuntimeUnsupportedReason ??
                  t("newSession.deviceFolderDescription"),
                disabled: Boolean(props.params.place.deviceFolderRuntimeUnsupportedReason),
                title: props.params.place.deviceFolderRuntimeUnsupportedReason,
                checked: Boolean(props.params.place.deviceFolder),
                onSelect: () => props.params.place.selectDeviceFolder(),
              }}
              submitting={props.params.submitting || props.params.pendingPlacement}
            />
          ) : undefined}
          <Show when={!view().query && view().deviceBrowse?.label}>
            {(deviceLabel) => (
              <button
                type="button"
                class="session-menu__item"
                data-value="browse-device"
                aria-pressed="false"
                disabled={props.params.submitting || props.params.pendingPlacement}
                ref={nativeListener("click", () =>
                  props.params.place.browser.selectDeviceBrowser(
                    props.params.place.deviceId,
                    props.params.place.deviceFolder?.path.trim() || undefined,
                  ),
                )}
              >
                <span class="session-menu__check" aria-hidden="true" />
                <span class="session-menu__text">
                  {t("newSession.browseDevice", { device: deviceLabel() })}
                </span>
                <span class="new-session-page__menu-chevron" aria-hidden="true">
                  <Icon name="chevronRight" />
                </span>
              </button>
            )}
          </Show>
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
          <label class="new-session-page__project-search">
            <span class="sr-only">{t("newSession.projectSearchPlaceholder")}</span>
            <input
              type="search"
              placeholder={t("newSession.projectSearchPlaceholder")}
              value={props.params.place.browser.projectQuery}
              disabled={props.params.submitting || props.params.pendingPlacement}
              onInput={(event: Event) =>
                props.params.place.browser.changeProjectQuery(
                  event.target instanceof HTMLInputElement ? event.target.value : "",
                )
              }
              ref={nativeListener("keydown", (event: KeyboardEvent) => {
                if (event.key === "Enter" && view().cloneInput && view().projectAddAvailable) {
                  event.preventDefault();
                  selectClone(view().cloneInput!);
                }
              })}
            />
          </label>
          {
            <For each={props.state.localProjects} keyed={(project) => project.id}>
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
          }
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
              {props.params.place.browser.projectSearchResult?.credential === "missing" ? (
                <div class="new-session-page__menu-note">{t("newSession.githubTokenHint")}</div>
              ) : undefined}
              {props.params.place.browser.projectSearchLoading ? (
                <div class="new-session-page__project-status" role="status">
                  {t("common.loading")}
                </div>
              ) : undefined}
              {props.params.place.browser.projectSearchError ? (
                <div class="new-session-page__project-error" role="alert">
                  {props.params.place.browser.projectSearchError}
                </div>
              ) : undefined}
              {
                <For
                  each={props.params.place.browser.projectSearchResult?.projects ?? []}
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
    </SessionPicker>
  );
}
