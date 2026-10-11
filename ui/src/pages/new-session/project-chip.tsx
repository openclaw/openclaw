import { createMemo, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { pathDisplayName } from "../../lib/path-display.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { parentFolderDisplayName } from "./path.ts";
import { PickerLabel } from "./picker-label.tsx";
import { PlaceBrowser } from "./place-browser.tsx";
import { disambiguate } from "./place-labels.ts";
import { projectCloneInput } from "./project-chip.ts";
import type { ProjectChipOptions } from "./project-chip.ts";
export function ProjectChip(props: { params: ProjectChipOptions }) {
  const selectClone = (cloneUrl: string) =>
    props.params.onSelectRemoteProject({ identity: cloneUrl, cloneUrl });
  const view = createMemo(() => {
    const folder = props.params.folder.trim();
    const cloneInput = projectCloneInput(props.params.projectQuery);
    const query = props.params.projectQuery.trim();
    const browseNeedsAdmin = !props.params.browseAvailable && !props.params.isAdmin;
    const recentItems = props.params.state.recents;
    const recentSuffixes = disambiguate(recentItems, (recent) => recent.displayName, [
      (recent) => (recent.kind === "folder" ? parentFolderDisplayName(recent.folder) : undefined),
      (recent) => (recent.kind === "folder" ? recent.folder : undefined),
      (recent) => (recent.kind === "folder" ? recent.folder : recent.url),
    ]);
    return { folder, cloneInput, query, browseNeedsAdmin, recentItems, recentSuffixes };
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
        (!props.params.browseAvailable && !view().browseNeedsAdmin)
      }
      ref={nativeListener("click", () => {
        if (
          props.params.browseAvailable &&
          !props.params.submitting &&
          !props.params.pendingPlacement
        ) {
          props.params.onBrowse();
        }
      })}
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
      <span class="new-session-page__select">
        <button
          id="new-session-project-trigger"
          type="button"
          class={[
            "new-session-page__trigger",
            { "new-session-page__trigger--hiding": props.params.popoverHiding },
          ]}
          aria-label={`${t("newSession.what")}: ${props.params.state.label}`}
          data-project-id={props.params.projectId || undefined}
          aria-haspopup="dialog"
          aria-expanded={props.params.popoverOpen ? "true" : "false"}
          disabled={props.params.submitting || props.params.pendingPlacement}
          ref={nativeListener("click", (event) => props.params.onGuardTransition(event))}
        >
          <PickerLabel
            icon={props.params.projectId ? <Icon name="gitBranch" /> : <Icon name="folder" />}
            label={props.params.state.label}
          />
        </button>
      </span>
      <wa-popover
        ref={syncPopoverLabel}
        class="new-session-page__select new-session-page__project-popover new-session-page__picker-popover"
        for="new-session-project-trigger"
        placement="bottom-start"
        without-arrow
        onWa-show={() => props.params.onPopoverShow()}
        onWa-hide={() => props.params.onPopoverHide()}
        onWa-after-hide={() => props.params.onPopoverAfterHide()}
      >
        {props.params.browserOpen ? (
          <PlaceBrowser
            params={{
              browser: props.params.browser,
              id: "new-session-place-browser",
              label: props.params.gatewayLabel,
              registerProjectPath: props.params.registerProjectPath,
              registeringProject: props.params.registeringProject,
              onBack: props.params.onBrowserBack,
              onRegisterProject: props.params.onRegisterProject,
              onClose: props.params.onClose,
              onApplyFolder: props.params.onApplyFolder,
            }}
          />
        ) : (
          <div class="new-session-page__picker-root">
            <div class="new-session-page__menu-title">{t("newSession.projects")}</div>
            {props.params.onNewWorkspace && !view().query ? (
              <SessionMenuItem
                item={{
                  value: "new-workspace",
                  label: t("newSession.newWorkspace"),
                  icon: <Icon name="folder" />,
                  sub: t("newSession.newWorkspaceDescription"),
                  checked: props.params.freshWorkspace === true,
                  onSelect: props.params.onNewWorkspace,
                }}
                submitting={props.params.submitting || props.params.pendingPlacement}
              />
            ) : undefined}
            {props.params.workspace && props.params.state.showWorkspace ? (
              <SessionMenuItem
                item={{
                  value: "workspace",
                  label: pathDisplayName(props.params.workspace),
                  icon: <Icon name="folder" />,
                  checked:
                    !props.params.freshWorkspace &&
                    !props.params.projectId &&
                    view().folder === props.params.workspace,
                  onSelect: () => props.params.onApplyFolder(props.params.workspace),
                }}
                submitting={props.params.submitting}
              />
            ) : undefined}
            <label class="new-session-page__project-search">
              <span class="sr-only">{t("newSession.projectSearchPlaceholder")}</span>
              <input
                type="search"
                placeholder={t("newSession.projectSearchPlaceholder")}
                value={props.params.projectQuery}
                disabled={props.params.submitting || props.params.pendingPlacement}
                onInput={(event: Event) =>
                  props.params.onProjectQueryInput(
                    event.target instanceof HTMLInputElement ? event.target.value : "",
                  )
                }
                ref={nativeListener("keydown", (event: KeyboardEvent) => {
                  if (
                    event.key === "Enter" &&
                    view().cloneInput &&
                    props.params.projectAddAvailable
                  ) {
                    event.preventDefault();
                    selectClone(view().cloneInput!);
                  }
                })}
              />
            </label>
            {
              <For each={props.params.state.localProjects} keyed={(project) => project.id}>
                {(project) => (
                  <SessionMenuItem
                    item={{
                      value: `project:${project().id}`,
                      label: project().displayName,
                      icon: <Icon name="gitBranch" />,
                      checked: props.params.projectId === project().id,
                      title: project().repoRoot,
                      onSelect: () => props.params.onSelectProject(project().id),
                    }}
                    submitting={props.params.submitting}
                  />
                )}
              </For>
            }
            {view().cloneInput && props.params.projectAddAvailable ? (
              <SessionMenuItem
                item={{
                  value: "project-clone-url",
                  label: view().cloneInput!,
                  icon: <Icon name="gitBranch" />,
                  sub: t("newSession.cloneProject"),
                  checked: props.params.selectedRemoteProject?.cloneUrl === view().cloneInput,
                  onSelect: () => selectClone(view().cloneInput!),
                }}
                submitting={props.params.submitting}
              />
            ) : undefined}
            {!view().cloneInput &&
            view().query.length >= 2 &&
            props.params.projectSearchAvailable ? (
              <>
                <div class="new-session-page__menu-title">{t("newSession.githubProjects")}</div>
                {props.params.projectSearchCredentialMissing ? (
                  <div class="new-session-page__menu-note">{t("newSession.githubTokenHint")}</div>
                ) : undefined}
                {props.params.projectSearchLoading ? (
                  <div class="new-session-page__project-status" role="status">
                    {t("common.loading")}
                  </div>
                ) : undefined}
                {props.params.projectSearchError ? (
                  <div class="new-session-page__project-error" role="alert">
                    {props.params.projectSearchError}
                  </div>
                ) : undefined}
                {
                  <For each={props.params.remoteProjects} keyed={(project) => project.cloneUrl}>
                    {(project) => (
                      <SessionMenuItem
                        item={{
                          value: `remote-project:${project().fullName}`,
                          label: project().fullName,
                          icon: <Icon name="gitBranch" />,
                          sub: project().description ?? t("newSession.cloneProject"),
                          checked:
                            props.params.selectedRemoteProject?.cloneUrl === project().cloneUrl,
                          title: project().webUrl,
                          onSelect: () =>
                            props.params.onSelectRemoteProject({
                              identity: project().fullName,
                              cloneUrl: project().cloneUrl,
                              ...(project().defaultBranch
                                ? { defaultBranch: project().defaultBranch }
                                : {}),
                            }),
                        }}
                        submitting={props.params.submitting || !props.params.projectAddAvailable}
                      />
                    )}
                  </For>
                }
              </>
            ) : undefined}
            {props.params.projects.length === 0 &&
            props.params.canWrite &&
            !props.params.isAdmin ? (
              <div class="new-session-page__menu-note">{t("newSession.projectsAdminHint")}</div>
            ) : undefined}
            {props.params.state.recents.length > 0 ? (
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
                    const item = createMemo(() => {
                      const row = recent();
                      return {
                        value:
                          row.kind === "repository"
                            ? `repository:${row.url}`
                            : `recent:${row.folder}`,
                        label: row.displayName,
                        icon:
                          row.kind === "folder" ? (
                            <Icon name="folder" />
                          ) : (
                            <Icon name="gitBranch" />
                          ),
                        sub: view().recentSuffixes[index()],
                        checked:
                          row.kind === "repository"
                            ? props.params.selectedRemoteProject?.cloneUrl === row.url
                            : !props.params.freshWorkspace &&
                              !props.params.projectId &&
                              view().folder === row.folder,
                        title: row.kind === "repository" ? row.url : row.folder,
                        onSelect: () => {
                          const selected = recent();
                          if (selected.kind === "repository") {
                            props.params.onSelectRemoteProject({
                              identity: selected.displayName,
                              cloneUrl: selected.url,
                            });
                          } else {
                            props.params.onApplyFolder(selected.folder);
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
      </wa-popover>
    </>
  );
}
