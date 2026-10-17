import { createMemo, createSignal, For, onCleanup, untrack } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import type { CheckoutChipOptions } from "./checkout-chip.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { isWorktreeNameValid } from "./create-params.ts";
import { SessionPicker } from "./picker.tsx";

function WorktreeFields(props: {
  params: CheckoutChipOptions;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false);
  let baseRef!: HTMLInputElement;
  let nameInput!: HTMLInputElement;
  const suggestionRefs = new Map<string, HTMLButtonElement>();
  let activeSuggestion: HTMLButtonElement | undefined;
  const clearActiveSuggestion = () => {
    baseRef.removeAttribute("aria-activedescendant");
    activeSuggestion?.setAttribute("aria-selected", "false");
    activeSuggestion = undefined;
  };
  const closeSuggestions = () => {
    setSuggestionsOpen(false);
    clearActiveSuggestion();
  };
  // Native selection commits synchronously, including consecutive keys before Solid settles.
  const handleBranchKeydown = (event: KeyboardEvent) => {
    const rows = suggestions().flatMap((branch) => suggestionRefs.get(branch.name) ?? []);
    if (event.currentTarget !== baseRef || rows.length === 0) {
      return false;
    }
    const activeIndex = activeSuggestion ? rows.indexOf(activeSuggestion) : -1;
    if (event.key === "Enter" && !event.isComposing && activeIndex >= 0) {
      activeSuggestion!.click();
      return true;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return false;
    }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      activeIndex < 0
        ? direction === 1
          ? 0
          : rows.length - 1
        : (activeIndex + direction + rows.length) % rows.length;
    clearActiveSuggestion();
    activeSuggestion = rows[nextIndex]!;
    activeSuggestion.setAttribute("aria-selected", "true");
    baseRef.setAttribute("aria-activedescendant", activeSuggestion.id);
    setSuggestionsOpen(true);
    return true;
  };
  const handleFieldKeydown = (event: KeyboardEvent) => {
    if (handleBranchKeydown(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (
      event.key !== "Enter" ||
      event.isComposing ||
      (!props.params.repository && !isWorktreeNameValid(nameInput.value))
    ) {
      return;
    }
    event.preventDefault();
    props.onConfirm();
  };
  const suggestions = createMemo(() => (props.params.branches?.branches ?? []).slice(0, 8));
  const branchName = () => props.params.worktreeName.trim();
  const baseRefInput = (
    <input
      id="new-session-worktree-base-ref"
      type="text"
      role={suggestions().length ? "combobox" : undefined}
      aria-label={t("newSession.worktreeBaseRef")}
      aria-autocomplete={suggestions().length ? "list" : undefined}
      aria-controls={suggestions().length ? "new-session-worktree-branch-suggestions" : undefined}
      aria-expanded={suggestions().length ? (suggestionsOpen() ? "true" : "false") : undefined}
      disabled={props.params.submitting || props.params.pendingPlacement}
      placeholder={
        props.params.branchesLoading
          ? t("common.loading")
          : (props.params.branches?.defaultBranch ?? t("newSession.worktreeBaseRef"))
      }
      value={props.params.baseRef}
      onFocus={() => setSuggestionsOpen(true)}
      onInput={(event) => {
        clearActiveSuggestion();
        setSuggestionsOpen(true);
        props.params.onBaseRefInput(event.currentTarget.value);
      }}
      ref={(node) => {
        baseRef = node;
      }}
      onKeyDown={handleFieldKeydown}
    />
  );
  return (
    <>
      <div class="new-session-page__menu-field">
        <span>{t("newSession.worktreeBaseRef")}</span>
        {suggestions().length ? (
          <div
            class="new-session-page__branch-field"
            onFocusOut={(event) => {
              if (
                !(event.relatedTarget instanceof Node) ||
                !event.currentTarget.contains(event.relatedTarget)
              ) {
                closeSuggestions();
              }
            }}
          >
            {baseRefInput}
            <Popover
              id="new-session-worktree-branch-popup"
              label={t("newSession.worktreeBaseRef")}
              class="new-session-page__branch-popup"
              anchor={baseRef}
              open={suggestionsOpen()}
              onOpenChange={setSuggestionsOpen}
            >
              <div
                id="new-session-worktree-branch-suggestions"
                class="new-session-page__branch-suggestions"
                role="listbox"
                aria-label={t("newSession.worktreeBaseRef")}
              >
                <For each={suggestions()} keyed={(branch) => branch.name}>
                  {(branch, index) => {
                    let button: HTMLButtonElement;
                    // The For key fixes this identity for the row's entire lifetime.
                    const name = untrack(() => branch().name);
                    onCleanup(() => {
                      suggestionRefs.delete(name);
                      if (activeSuggestion === button) {
                        clearActiveSuggestion();
                      }
                    });
                    return (
                      <button
                        id={`new-session-worktree-branch-suggestion-${index()}`}
                        type="button"
                        role="option"
                        aria-selected="false"
                        class="session-menu__item"
                        data-worktree-suggestion={branch().name}
                        tabindex="-1"
                        onMouseDown={(event: MouseEvent) => event.preventDefault()}
                        ref={[
                          (node) => {
                            button = node;
                            suggestionRefs.set(name, node);
                          },
                          nativeListener("click", () => {
                            props.params.onBaseRefInput(branch().name);
                            closeSuggestions();
                          }),
                        ]}
                      >
                        <span class="session-menu__text">{branch().name}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </Popover>
          </div>
        ) : (
          baseRefInput
        )}
      </div>
      <div class="new-session-page__menu-note">
        {t(
          props.params.branches?.branchesUnavailable
            ? "newSession.worktreeBranchesUnavailable"
            : "newSession.worktreeBranchesLimited",
        )}
      </div>
      {props.params.repository ? undefined : (
        <>
          <label class="new-session-page__menu-field">
            <span>{t("newSession.worktreeName")}</span>
            <input
              type="text"
              data-worktree-name=""
              disabled={props.params.submitting || props.params.pendingPlacement}
              placeholder={t("newSession.worktreeNamePlaceholder")}
              value={props.params.worktreeName}
              onInput={(event) => props.params.onWorktreeNameInput(event.currentTarget.value)}
              ref={[(node) => (nameInput = node), nativeListener("keydown", handleFieldKeydown)]}
            />
          </label>
          <div class="new-session-page__menu-note">
            {branchName()
              ? t("newSession.worktreeBranchNote", { branch: `openclaw/${branchName()}` })
              : t("newSession.worktreeBranchFromTitleNote")}
          </div>
        </>
      )}
    </>
  );
}

export function CheckoutChip(props: { params: CheckoutChipOptions }) {
  let popover!: PopoverHandle;
  let confirmPending = false;
  return (
    <SessionPicker
      kind="checkout"
      label={`${t("newSession.checkout")}: ${props.params.state.label}`}
      value={props.params.state.label}
      icon={<Icon name="gitBranch" />}
      triggerAttributes={{
        title: `${t("newSession.checkout")}: ${props.params.state.label}`,
        "data-worktree": String(props.params.worktree),
      }}
      state={props.params}
      ref={(handle) => {
        popover = handle;
      }}
      onAfterHide={() => {
        if (confirmPending) {
          confirmPending = false;
          props.params.onConfirm();
        }
      }}
    >
      <div class="new-session-page__picker-root">
        <div class="new-session-page__menu-title">{t("newSession.checkout")}</div>
        {props.params.repository ? undefined : (
          <>
            <SessionMenuItem
              item={{
                value: "checkout",
                label: t("newSession.checkoutCurrent"),
                icon: <Icon name="folder" />,
                sub: props.params.branches?.headBranch,
                description: props.params.currentCheckoutUnavailableReason,
                checked: !props.params.worktree,
                disabled:
                  props.params.remotePlacement ||
                  Boolean(props.params.currentCheckoutUnavailableReason),
                title: props.params.remotePlacement
                  ? t("newSession.checkoutRemoteLocked")
                  : props.params.currentCheckoutUnavailableReason,
                onSelect: () => props.params.onSelectWorktree(false),
                keepOpen: true,
              }}
              submitting={props.params.submitting}
            />
            <SessionMenuItem
              item={{
                value: "worktree",
                label: t("newSession.checkoutWorktree"),
                icon: <Icon name="gitBranch" />,
                sub: t("newSession.checkoutWorktreeSub"),
                checked: props.params.worktree,
                disabled: !props.params.worktreeAvailable,
                title: props.params.worktreeAvailable
                  ? undefined
                  : (props.params.currentCheckoutUnavailableReason ??
                    (props.params.repositoryUnavailable
                      ? t("newSession.gitCheckUnavailable")
                      : t("newSession.worktreeUnavailable"))),
                onSelect: () => props.params.onSelectWorktree(true),
                keepOpen: true,
              }}
              submitting={props.params.submitting}
            />
          </>
        )}
        {props.params.worktree || props.params.repository ? (
          <WorktreeFields
            params={props.params}
            onClose={() => popover.hide()}
            onConfirm={() => {
              if (popover.hide()) {
                confirmPending = true;
              }
            }}
          />
        ) : undefined}
        {props.params.remotePlacement ? (
          <div class="new-session-page__menu-note">
            {t(
              props.params.repository
                ? "newSession.placementClonesRepository"
                : "newSession.placementSyncsFolder",
              { folder: props.params.folderLabel },
            )}
          </div>
        ) : undefined}
      </div>
    </SessionPicker>
  );
}
