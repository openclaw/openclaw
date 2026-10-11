import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import { render as renderSolid } from "@solidjs/web";
import { nothing, render as renderLit } from "lit";
import { createEffect, createMemo, createSignal, onCleanup, For } from "solid-js";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
} from "../../../packages/gateway-protocol/src/index.js";
import { t } from "../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../lib/format-error.ts";
import { pathDisplayName } from "../lib/path-display.ts";
import { PlaceBrowserState } from "../pages/new-session/place-browser-state.ts";
import { renderPlaceBrowser } from "../pages/new-session/place-browser.ts";
import "../styles/new-session.css";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { Icon } from "./solid/icon.tsx";
import { syncPopoverLabel } from "./web-awesome-popover.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

registerSessionOrganizationEnglish();

registerNewSessionSetupEnglish();

export type SessionGroupDefaults = { cwd: string; worktree: boolean };

type Options = {
  group: string;
  defaults: SessionGroupDefaults;
  listDirectory: (path?: string) => Promise<FsListDirResult>;
  inspectRepository: (path?: string) => Promise<WorktreeRepositoryStatus>;
  submit: (defaults: SessionGroupDefaults) => Promise<string | null>;
};

let active = false;

export function showSessionGroupDefaultsDialog(options: Options): Promise<void> {
  if (active) {
    return Promise.resolve();
  }
  active = true;
  return withPromiseModalHost<void>(undefined, ({ host, finish: settle }) => {
    const [revision, setRevision] = createSignal(0);
    let cwd = options.defaults.cwd;
    let worktree = false;
    let repositoryStatus: WorktreeRepositoryStatus | "checking" | "restricted" = "checking";
    let repositoryRequestToken = 0;
    let submitting = false;
    let failure: string | null = null;
    let browserVisible = false;
    const browser = new PlaceBrowserState(options.listDirectory, paint);

    const finish = () => {
      browser.reset();
      repositoryRequestToken += 1;
      dispose?.();
      settle();
      active = false;
    };

    const handleSubmit = async (event: Event) => {
      event.preventDefault();
      if (submitting || (repositoryStatus !== "git" && repositoryStatus !== "not_git")) {
        return;
      }
      submitting = true;
      failure = null;
      paint();
      try {
        failure = await options.submit({
          cwd: cwd.trim(),
          worktree: repositoryStatus === "git" && worktree,
        });
      } catch (error) {
        failure = formatUiError(error);
      }
      if (!failure) {
        finish();
        return;
      }
      submitting = false;
      paint();
    };

    const closePicker = () => {
      const picker = host.querySelector<HTMLElement & { open: boolean }>(
        "wa-popover.session-group-defaults__folder-popover",
      );
      if (picker) {
        picker.open = false;
      }
    };

    const showPickerRoot = () => {
      browser.reset();
      browserVisible = false;
      paint();
    };

    const applyFolder = (path: string) => {
      cwd = path.trim();
      showPickerRoot();
      closePicker();
      void inspectRepository(false);
    };

    const inspectRepository = async (restoreSavedWorktree: boolean) => {
      const requestToken = ++repositoryRequestToken;
      repositoryStatus = "checking";
      worktree = false;
      failure = null;
      paint();
      try {
        const status = await options.inspectRepository(cwd.trim() || undefined);
        if (requestToken !== repositoryRequestToken) {
          return;
        }
        repositoryStatus = status;
        worktree = status === "git" && restoreSavedWorktree && options.defaults.worktree;
      } catch (error) {
        if (requestToken !== repositoryRequestToken) {
          return;
        }
        worktree = false;
        // A path-authorization denial is not a repository status: collapsing it
        // into "couldn't verify Git" would present a retry that can never
        // succeed while the connection still lacks the required operator scope.
        repositoryStatus = readMissingScopeError(error) ? "restricted" : "unavailable";
      }
      paint();
    };

    const selectWorktree = (value: boolean) => {
      worktree = value;
      failure = null;
      paint();
    };

    const handleModeSelect = (event: CustomEvent<{ item: Element }>) => {
      const value = event.detail.item.getAttribute("value");
      if (value !== "local" && value !== "worktree") {
        return;
      }
      selectWorktree(value === "worktree");
    };

    const handleModeKeydown = (event: KeyboardEvent) => {
      if (!(event.currentTarget instanceof HTMLElement)) {
        return;
      }
      const dropdown = event.currentTarget as HTMLElement & { open?: boolean };
      if (event.key !== "Escape" || !dropdown.open) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dropdown.open = false;
      dropdown
        .querySelector<HTMLElement>("#session-group-defaults-mode-trigger")
        ?.focus({ preventScroll: true });
    };

    const showBrowser = () => {
      browserVisible = true;
      void browser.navigate(cwd || undefined, "initial");
    };

    function paint() {
      setRevision((value) => value + 1);
    }
    function Dialog() {
      const state = createMemo(() => {
        revision();
        const trimmedCwd = cwd.trim();
        const environmentOptions = [
          {
            value: "local",
            label: t("sessionsView.groupDefaultsLocal"),
            description: t("newSession.checkoutCurrentNote"),
            icon: "monitor" as const,
          },
          {
            value: "worktree",
            label: t("sessionsView.groupDefaultsWorktree"),
            description: t("sessionsView.groupDefaultsWorktreeHint"),
            icon: "gitBranch" as const,
          },
        ];
        return {
          trimmedCwd,
          folderLabel: trimmedCwd
            ? pathDisplayName(trimmedCwd)
            : t("sessionsView.groupDefaultsCwdPlaceholder"),
          environmentOptions,
          selectedEnvironment: environmentOptions[worktree ? 1 : 0]!,
          environmentState:
            repositoryStatus === "checking"
              ? "checking"
              : repositoryStatus === "git"
                ? "git"
                : repositoryStatus === "restricted"
                  ? "restricted"
                  : "local",
          repositoryStatus,
          submitting,
          failure,
          browserVisible,
        };
      });
      function Browser() {
        const element = document.createElement("div");
        createEffect(
          () => {
            revision();
            return browserVisible
              ? renderPlaceBrowser({
                  browser,
                  id: "session-group-defaults-browser",
                  label: t("newSession.gateway"),
                  registerProjectPath: null,
                  registeringProject: false,
                  onBack: showPickerRoot,
                  onRegisterProject: () => undefined,
                  onClose: showPickerRoot,
                  onApplyFolder: applyFolder,
                })
              : nothing;
          },
          (content) => {
            renderLit(content, element);
          },
        );
        onCleanup(() => {
          renderLit(nothing, element);
        });
        return element;
      }
      function ModeOption(props: { index: number }) {
        const option = () => state().environmentOptions[props.index]!;
        const [element, setElement] = createSignal<HTMLElement>();
        createEffect(
          () => ({
            element: element(),
            selected: option().value === state().selectedEnvironment.value,
          }),
          (selection) => {
            syncDropdownItemRadio(selection.element, selection.selected);
          },
        );
        return (
          <wa-dropdown-item
            class="session-group-defaults__mode-option"
            data-environment-mode={option().value}
            data-selected={option().value === state().selectedEnvironment.value ? "" : undefined}
            aria-label={`${option().label}, ${option().description}`}
            value={option().value}
            type="checkbox"
            prop:checked={option().value === state().selectedEnvironment.value}
            disabled={state().submitting}
            autofocus={option().value === state().selectedEnvironment.value && !state().submitting}
            ref={setElement}
          >
            <span
              slot="icon"
              class="new-session-page__target-icon session-group-defaults__mode-option-icon"
              aria-hidden="true"
            >
              <Icon name={option().icon} />
            </span>
            <span class="session-group-defaults__resolved-copy">
              <strong>{option().label}</strong>
              <small>{option().description}</small>
            </span>
          </wa-dropdown-item>
        );
      }
      return (
        <openclaw-modal-dialog
          label={t("sessionsView.groupDefaultsTitle", { group: options.group })}
          onModal-cancel={(event: Event) => {
            if (state().submitting) {
              event.preventDefault();
            } else {
              finish();
            }
          }}
        >
          <form class="exec-approval-card session-group-defaults" onSubmit={handleSubmit}>
            <div class="exec-approval-header">
              <div>
                <div class="exec-approval-title">
                  {t("sessionsView.groupDefaultsTitle", { group: options.group })}
                </div>
                <div class="exec-approval-sub">{t("sessionsView.groupDefaultsDescription")}</div>
              </div>
            </div>
            <div class="session-group-defaults__fields">
              <div class="field">
                <span>{t("sessionsView.groupDefaultsCwd")}</span>
                <button
                  id="session-group-defaults-folder-trigger"
                  type="button"
                  class="new-session-page__trigger session-group-defaults__folder"
                  aria-label={`${t("sessionsView.groupDefaultsCwd")}: ${state().folderLabel}`}
                  aria-haspopup="dialog"
                  disabled={state().submitting}
                >
                  <span class="new-session-page__target-icon" aria-hidden="true">
                    <Icon name="folder" />
                  </span>
                  <span class="session-group-defaults__folder-copy">
                    <strong>{state().folderLabel}</strong>
                    <small title={state().trimmedCwd || undefined}>
                      {state().trimmedCwd || t("sessionsView.groupDefaultsCwdHint")}
                    </small>
                  </span>
                  <span class="new-session-page__trigger-chevron" aria-hidden="true">
                    <Icon name="chevronDown" />
                  </span>
                </button>
                <wa-popover
                  ref={syncPopoverLabel}
                  class="new-session-page__select new-session-page__project-popover new-session-page__picker-popover session-group-defaults__folder-popover"
                  for="session-group-defaults-folder-trigger"
                  placement="bottom-start"
                  without-arrow
                  onWa-hide={showPickerRoot}
                >
                  {state().browserVisible ? (
                    <Browser />
                  ) : (
                    <div class="new-session-page__picker-root">
                      <button
                        type="button"
                        class="session-menu__item"
                        data-value="agent-workspace"
                        data-popover="close"
                        aria-pressed={String(!state().trimmedCwd)}
                        disabled={state().submitting}
                        onClick={() => applyFolder("")}
                      >
                        <span class="session-menu__icon" aria-hidden="true">
                          <Icon name="folder" />
                        </span>
                        <span class="session-menu__text">
                          {t("sessionsView.groupDefaultsCwdPlaceholder")}
                        </span>
                        <span class="session-menu__check" aria-hidden="true">
                          {!state().trimmedCwd ? <Icon name="check" /> : undefined}
                        </span>
                      </button>
                      <button
                        type="button"
                        class="session-menu__item"
                        data-value="browse"
                        aria-pressed="false"
                        disabled={state().submitting}
                        onClick={showBrowser}
                      >
                        <span class="session-menu__check" aria-hidden="true" />
                        <span class="session-menu__text">{t("newSession.browse")}</span>
                        <span class="new-session-page__menu-chevron" aria-hidden="true">
                          <Icon name="chevronRight" />
                        </span>
                      </button>
                    </div>
                  )}
                </wa-popover>
              </div>
              <div class="field">
                <span>{t("sessionsView.groupDefaultsMode")}</span>
                <div
                  class="session-group-defaults__environment"
                  data-session-group-environment={state().environmentState}
                  aria-live="polite"
                >
                  {state().repositoryStatus === "git" ? (
                    <wa-dropdown
                      class="session-group-defaults__mode-dropdown"
                      placement="bottom-start"
                      aria-label={t("sessionsView.groupDefaultsMode")}
                      onWa-select={handleModeSelect}
                      onKeyDown={handleModeKeydown}
                    >
                      <button
                        id="session-group-defaults-mode-trigger"
                        slot="trigger"
                        type="button"
                        class="session-group-defaults__resolved-mode session-group-defaults__mode-trigger"
                        data-value={state().selectedEnvironment.value}
                        aria-label={`${t("sessionsView.groupDefaultsMode")}: ${state().selectedEnvironment.label}`}
                        disabled={state().submitting}
                      >
                        <span class="new-session-page__target-icon" aria-hidden="true">
                          <Icon name={state().selectedEnvironment.icon} />
                        </span>
                        <span class="session-group-defaults__resolved-copy">
                          <strong>{state().selectedEnvironment.label}</strong>
                          <small>{state().selectedEnvironment.description}</small>
                        </span>
                        <span class="new-session-page__trigger-chevron" aria-hidden="true">
                          <Icon name="chevronDown" />
                        </span>
                      </button>
                      <For each={[0, 1]}>{(index) => <ModeOption index={index} />}</For>
                    </wa-dropdown>
                  ) : (
                    <div
                      class="session-group-defaults__resolved-mode"
                      role={state().repositoryStatus === "checking" ? "status" : undefined}
                    >
                      <span class="new-session-page__target-icon" aria-hidden="true">
                        <Icon
                          name={state().repositoryStatus === "checking" ? "gitBranch" : "monitor"}
                        />
                      </span>
                      <span class="session-group-defaults__resolved-copy">
                        <strong>
                          {state().repositoryStatus === "checking"
                            ? t("newSession.checkingGit")
                            : t("sessionsView.groupDefaultsLocal")}
                        </strong>
                        {state().repositoryStatus !== "checking" ? (
                          <small>
                            {state().repositoryStatus === "restricted"
                              ? t("sessionsView.groupDefaultsRequiresAdmin")
                              : state().repositoryStatus === "unavailable"
                                ? t("newSession.gitCheckUnavailable")
                                : t("newSession.checkoutCurrentNote")}
                          </small>
                        ) : undefined}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {state().failure ? (
              <div class="exec-approval-error" role="alert">
                {state().failure}
              </div>
            ) : undefined}
            <div class="exec-approval-actions">
              <button
                type="submit"
                class="btn primary"
                disabled={
                  state().submitting ||
                  state().repositoryStatus === "checking" ||
                  state().repositoryStatus === "unavailable" ||
                  state().repositoryStatus === "restricted"
                }
              >
                {t("common.save")}
              </button>
              {state().repositoryStatus === "unavailable" ||
              state().repositoryStatus === "restricted" ? (
                <button
                  type="button"
                  class="btn"
                  disabled={state().submitting}
                  onClick={() => void inspectRepository(cwd.trim() === options.defaults.cwd.trim())}
                >
                  {t("common.retry")}
                </button>
              ) : undefined}
              <button type="button" class="btn" disabled={state().submitting} onClick={finish}>
                {t("common.cancel")}
              </button>
            </div>
          </form>
        </openclaw-modal-dialog>
      );
    }
    const dispose = renderSolid(() => <Dialog />, host);
    void inspectRepository(true);
  });
}
