import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  isPending,
  Loading,
  onSettled,
  Reveal,
  Show,
} from "solid-js";
import type {
  FsListDirResult,
  WorktreeRepositoryStatus,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerNewSessionSetupEnglish } from "../i18n/locales/en-new-session-setup.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { formatUiError } from "../lib/format-error.ts";
import { pathDisplayName } from "../lib/path-display.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { PlaceBrowserState } from "../pages/new-session/place-browser-state.ts";
import { PlaceBrowser } from "../pages/new-session/place-browser.tsx";
import "../styles/new-session.css";
import { withPromiseModalHost } from "./promise-modal-host.ts";
import { Icon } from "./solid/icon.tsx";
import { Menu, type MenuEntry } from "./solid/menu.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";

registerEnglishCatalog(registerSessionOrganizationEnglish);
registerEnglishCatalog(registerNewSessionSetupEnglish);

export type SessionGroupDefaults = { cwd: string; worktree: boolean };
type RepositoryStatus = WorktreeRepositoryStatus | "checking" | "restricted";

type Options = {
  group: string;
  signal?: AbortSignal;
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
  return withPromiseModalHost<void>({ signal: options.signal, value: undefined }, (modal) => {
    const { finish, render } = modal;
    const [cwd, setCwd] = createSignal(options.defaults.cwd);
    const [worktree, setWorktree] = createSignal(false);
    let repositoryStatus: RepositoryStatus = "checking";
    const [inspection, setInspection] = createSignal<Promise<RepositoryStatus>>();
    let repositoryRequestToken = 0;
    // Admission stays synchronous while the signals publish the visible status.
    let submitting = false;
    const [saving, setSaving] = createOptimistic(false);
    const [attempt, setAttempt] = createSignal<{ result: Promise<void> }>();
    const [browserVisible, setBrowserVisible] = createSignal(false);
    let folderPopover: PopoverHandle | undefined;
    const browser = new PlaceBrowserState(options.listDirectory, () => publishBrowser(browser));
    const [browserView, publishBrowser] = createSignal(browser, { equals: false });

    const performSubmit = action(function* () {
      setSaving(true);
      try {
        const errorMessage: string | null = yield options.submit({
          cwd: cwd().trim(),
          worktree: repositoryStatus === "git" && worktree(),
        });
        if (modal.settled) {
          return;
        }
        if (errorMessage) {
          throw new Error(errorMessage);
        }
        finish();
      } finally {
        submitting = false;
      }
    });
    const handleSubmit = (event: Event) => {
      event.preventDefault();
      if (submitting || (repositoryStatus !== "git" && repositoryStatus !== "not_git")) {
        return;
      }
      submitting = true;
      const result = performSubmit();
      setAttempt({ result });
      // The modal can retire before its error slot observes the admitted save.
      void result.catch(() => {});
    };

    const closePicker = () => {
      folderPopover?.overlay.request(false, "return");
    };

    const showPickerRoot = () => {
      browser.reset();
      setBrowserVisible(false);
    };

    const applyFolder = (path: string) => {
      const nextCwd = path.trim();
      setCwd(nextCwd);
      showPickerRoot();
      closePicker();
      void inspectRepository(false, nextCwd);
    };

    const inspectRepository = (restoreSavedWorktree: boolean, path: string) => {
      const requestToken = ++repositoryRequestToken;
      repositoryStatus = "checking";
      setWorktree(false);
      setAttempt(undefined);
      const result = (async () => {
        let status: RepositoryStatus;
        try {
          status = await options.inspectRepository(path.trim() || undefined);
        } catch (error) {
          // A path-authorization denial is not a repository status: collapsing it
          // into "couldn't verify Git" would present a retry that can never
          // succeed while the connection still lacks the required operator scope.
          status = readMissingScopeError(error) ? "restricted" : "unavailable";
        }
        if (requestToken === repositoryRequestToken) {
          repositoryStatus = status;
          setWorktree(status === "git" && restoreSavedWorktree && options.defaults.worktree);
        }
        return status;
      })();
      void setInspection(result);
      return result;
    };

    const selectWorktree = (value: boolean) => {
      setWorktree(value);
      setAttempt(undefined);
    };

    const showBrowser = () => {
      setBrowserVisible(true);
      void browser.navigate(cwd() || undefined, "initial");
    };

    function Dialog() {
      let folderAnchor!: HTMLButtonElement;
      let rootButton!: HTMLButtonElement;
      onSettled(() => () => {
        browser.reset();
        repositoryRequestToken += 1;
      });
      const trimmedCwd = () => cwd().trim();
      const folderLabel = () =>
        trimmedCwd()
          ? pathDisplayName(trimmedCwd())
          : t("sessionsView.groupDefaultsCwdPlaceholder");
      const environmentOptions = createMemo(() => [
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
      ]);
      const selectedEnvironment = () => environmentOptions()[worktree() ? 1 : 0]!;
      const environmentItems = createMemo<MenuEntry[]>(() =>
        environmentOptions().map((option) => ({
          id: option.value,
          label: `${option.label}, ${option.description}`,
          type: "radio" as const,
          checked: option.value === selectedEnvironment().value,
          disabled: saving(),
          class: "session-group-defaults__mode-option",
          attributes: {
            "data-environment-mode": option.value,
            "data-selected": option.value === selectedEnvironment().value ? "" : undefined,
            "data-initial-focus": option.value === selectedEnvironment().value ? "" : undefined,
          },
          icon: (
            <span
              class="new-session-page__target-icon session-group-defaults__mode-option-icon"
              aria-hidden="true"
            >
              <Icon name={option.icon} />
            </span>
          ),
          content: (
            <span class="session-group-defaults__resolved-copy">
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
          ),
        })),
      );
      const outcome = createMemo(() => attempt()?.result.then(() => null), {
        loadingValue: undefined,
      });
      const repositoryRead = createMemo(
        () => inspection() ?? Promise.resolve<RepositoryStatus>("checking"),
      );
      const repository = () => (isPending(repositoryRead) ? "checking" : repositoryRead());
      function Browser() {
        let pathInput!: HTMLInputElement;
        onSettled(() => {
          pathInput.focus({ preventScroll: true });
        });
        const content = createMemo(() => ({
          browser: browserView(),
          id: "session-group-defaults-browser",
          label: t("newSession.gateway"),
          registerProjectPath: null,
          onBack: showPickerRoot,
          onClose: showPickerRoot,
          onApplyFolder: applyFolder,
          onRegisterProject: () => {},
        }));
        return (
          <PlaceBrowser
            params={content()}
            registeringProject={false}
            pathRef={(node) => (pathInput = node)}
          />
        );
      }
      function PickerRoot() {
        onSettled(() => {
          if (folderPopover?.overlay.open) {
            rootButton?.focus({ preventScroll: true });
          }
        });
        return (
          <div class="new-session-page__picker-root">
            <button
              type="button"
              class="session-menu__item"
              data-value="agent-workspace"
              data-popover="close"
              aria-pressed={!trimmedCwd() ? "true" : "false"}
              disabled={saving()}
              ref={[nativeListener("click", () => applyFolder("")), (el) => (rootButton = el)]}
            >
              <span class="session-menu__icon" aria-hidden="true">
                <Icon name="folder" />
              </span>
              <span class="session-menu__text">
                {t("sessionsView.groupDefaultsCwdPlaceholder")}
              </span>
              <span class="session-menu__check" aria-hidden="true">
                {!trimmedCwd() ? <Icon name="check" /> : undefined}
              </span>
            </button>
            <button
              type="button"
              class="session-menu__item"
              data-value="browse"
              aria-pressed="false"
              disabled={saving()}
              onClick={showBrowser}
            >
              <span class="session-menu__check" aria-hidden="true" />
              <span class="session-menu__text">{t("newSession.browse")}</span>
              <span class="new-session-page__menu-chevron" aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            </button>
          </div>
        );
      }
      function Environment(props: { status: RepositoryStatus }) {
        const environmentState = () =>
          props.status === "checking" || props.status === "git" || props.status === "restricted"
            ? props.status
            : "local";
        return (
          <div class="field">
            <span>{t("sessionsView.groupDefaultsMode")}</span>
            <div
              class="session-group-defaults__environment"
              data-session-group-environment={environmentState()}
              aria-live="polite"
            >
              {props.status === "git" ? (
                <Menu
                  id="session-group-defaults-mode"
                  class="session-group-defaults__mode-dropdown"
                  panelClass="session-group-defaults__mode-menu"
                  triggerClass="session-group-defaults__resolved-mode session-group-defaults__mode-trigger"
                  triggerAttributes={{
                    id: "session-group-defaults-mode-trigger",
                    "data-value": selectedEnvironment().value,
                  }}
                  label={`${t("sessionsView.groupDefaultsMode")}: ${selectedEnvironment().label}`}
                  disabled={saving()}
                  onSelect={(item) => selectWorktree(item.id === "worktree")}
                  items={environmentItems()}
                  trigger={
                    <>
                      <span class="new-session-page__target-icon" aria-hidden="true">
                        <Icon name={selectedEnvironment().icon} />
                      </span>
                      <span class="session-group-defaults__resolved-copy">
                        <strong>{selectedEnvironment().label}</strong>
                        <small>{selectedEnvironment().description}</small>
                      </span>
                      <span class="new-session-page__trigger-chevron" aria-hidden="true">
                        <Icon name="chevronDown" />
                      </span>
                    </>
                  }
                />
              ) : (
                <div
                  class="session-group-defaults__resolved-mode"
                  role={props.status === "checking" ? "status" : undefined}
                >
                  <span class="new-session-page__target-icon" aria-hidden="true">
                    <Icon name={props.status === "checking" ? "gitBranch" : "monitor"} />
                  </span>
                  <span class="session-group-defaults__resolved-copy">
                    <strong>
                      {props.status === "checking"
                        ? t("newSession.checkingGit")
                        : t("sessionsView.groupDefaultsLocal")}
                    </strong>
                    {props.status !== "checking" ? (
                      <small>
                        {props.status === "restricted"
                          ? t("sessionsView.groupDefaultsRequiresAdmin")
                          : props.status === "unavailable"
                            ? t("newSession.gitCheckUnavailable")
                            : t("newSession.checkoutCurrentNote")}
                      </small>
                    ) : undefined}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      }
      function RepositoryActions(props: { status: RepositoryStatus; onRetry?: () => void }) {
        return (
          <>
            {props.status === "unavailable" || props.status === "restricted" ? (
              <button
                type="button"
                class="btn"
                disabled={saving()}
                onClick={() => {
                  void inspectRepository(cwd().trim() === options.defaults.cwd.trim(), cwd());
                  props.onRetry?.();
                }}
              >
                {t("common.retry")}
              </button>
            ) : undefined}
            <button
              type="submit"
              class="btn primary"
              disabled={
                saving() ||
                props.status === "checking" ||
                props.status === "unavailable" ||
                props.status === "restricted"
              }
            >
              {t("common.save")}
            </button>
          </>
        );
      }
      return (
        <openclaw-modal-dialog
          label={t("sessionsView.groupDefaultsTitle", { group: options.group })}
          onModal-cancel={(event: Event) => {
            if (submitting) {
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
            <Errored
              fallback={(error, reset) => (
                <>
                  <div class="exec-approval-error" role="alert">
                    {formatUiError(error())}
                  </div>
                  <openclaw-modal-actions class="exec-approval-actions">
                    <RepositoryActions status="unavailable" onRetry={reset} />
                    <button type="button" class="btn" disabled={saving()} onClick={() => finish()}>
                      {t("common.cancel")}
                    </button>
                  </openclaw-modal-actions>
                </>
              )}
            >
              <Reveal order="together">
                <div class="session-group-defaults__fields">
                  <div class="field">
                    <span>{t("sessionsView.groupDefaultsCwd")}</span>
                    <button
                      id="session-group-defaults-folder-trigger"
                      type="button"
                      class="new-session-page__trigger session-group-defaults__folder"
                      aria-label={`${t("sessionsView.groupDefaultsCwd")}: ${folderLabel()}`}
                      aria-haspopup="dialog"
                      aria-controls="session-group-defaults-folder-popover"
                      disabled={saving()}
                      ref={(element) => {
                        folderAnchor = element;
                      }}
                      onClick={() => {
                        const overlay = folderPopover?.overlay;
                        overlay?.request(!overlay.open, overlay.open ? "return" : "none");
                      }}
                    >
                      <span class="new-session-page__target-icon" aria-hidden="true">
                        <Icon name="folder" />
                      </span>
                      <span class="session-group-defaults__folder-copy">
                        <strong>{folderLabel()}</strong>
                        <small title={trimmedCwd() || undefined}>
                          {trimmedCwd() || t("sessionsView.groupDefaultsCwdHint")}
                        </small>
                      </span>
                      <span class="new-session-page__trigger-chevron" aria-hidden="true">
                        <Icon name="chevronDown" />
                      </span>
                    </button>
                    <Popover
                      id="session-group-defaults-folder-popover"
                      label={`${t("sessionsView.groupDefaultsCwd")}: ${folderLabel()}`}
                      anchor={folderAnchor}
                      class="new-session-page__select new-session-page__project-popover new-session-page__picker-popover session-group-defaults__folder-popover"
                      placement="bottom-start"
                      ref={(handle) => {
                        folderPopover = handle;
                      }}
                      onOpenChange={(open) => {
                        if (open) {
                          rootButton?.focus({ preventScroll: true });
                        } else {
                          showPickerRoot();
                        }
                      }}
                    >
                      {browserVisible() ? <Browser /> : <PickerRoot />}
                    </Popover>
                  </div>
                  <Loading fallback={<Environment status="checking" />}>
                    <Environment status={repository()} />
                  </Loading>
                </div>
                <Show when={!saving()}>
                  <Errored
                    fallback={(error) => (
                      <div class="exec-approval-error" role="alert">
                        {formatUiError(error())}
                      </div>
                    )}
                  >
                    {outcome()}
                  </Errored>
                </Show>
                <openclaw-modal-actions class="exec-approval-actions">
                  <button type="button" class="btn" disabled={saving()} onClick={() => finish()}>
                    {t("common.cancel")}
                  </button>
                  <Loading fallback={<RepositoryActions status="checking" />}>
                    <RepositoryActions status={repository()} />
                  </Loading>
                </openclaw-modal-actions>
              </Reveal>
            </Errored>
          </form>
        </openclaw-modal-dialog>
      );
    }
    render(() => <Dialog />);
    void inspectRepository(true, options.defaults.cwd);
  }).finally(() => {
    active = false;
  });
}
