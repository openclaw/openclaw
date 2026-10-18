import { createMemo, createSignal, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import type { CheckoutChipOptions } from "./checkout-chip.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { isWorktreeNameValid } from "./create-params.ts";
import { PickerLabel } from "./picker-label.tsx";
import { PickerPopover } from "./picker-popover.tsx";
function clearActiveBranchSuggestion(field: Element | null) {
  field?.querySelector("input")?.removeAttribute("aria-activedescendant");
  for (const suggestion of field?.querySelectorAll("[data-worktree-suggestion]") ?? []) {
    suggestion.setAttribute("aria-selected", "false");
  }
}

function handleBranchKeydown(target: HTMLElement, event: KeyboardEvent, show: () => void): boolean {
  const field = target.closest(".new-session-page__branch-field");
  const suggestions = [
    ...(field?.querySelectorAll<HTMLButtonElement>("[data-worktree-suggestion]") ?? []),
  ];
  if (suggestions.length === 0) {
    return false;
  }
  const activeIndex = suggestions.findIndex(
    (suggestion) => suggestion.getAttribute("aria-selected") === "true",
  );
  if (event.key === "Enter" && !event.isComposing && activeIndex >= 0) {
    suggestions[activeIndex]!.click();
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
        : suggestions.length - 1
      : (activeIndex + direction + suggestions.length) % suggestions.length;
  for (const [index, suggestion] of suggestions.entries()) {
    suggestion.setAttribute("aria-selected", String(index === nextIndex));
  }
  target.setAttribute("aria-activedescendant", suggestions[nextIndex]!.id);
  show();
  return true;
}

function WorktreeFields(props: {
  params: CheckoutChipOptions;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [suggestionsOpen, setSuggestionsOpen] = createSignal(false);
  let baseRef!: HTMLInputElement;
  const closeSuggestions = () => {
    setSuggestionsOpen(false);
    clearActiveBranchSuggestion(baseRef.closest(".new-session-page__branch-field"));
  };
  const handleFieldKeydown = (event: KeyboardEvent) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (handleBranchKeydown(target, event, () => setSuggestionsOpen(true))) {
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
    const popover = target.closest(".new-session-page__checkout-popover");
    const liveWorktreeName =
      popover?.querySelector<HTMLInputElement>("input[data-worktree-name]")?.value ??
      props.params.worktreeName;
    if (
      event.key !== "Enter" ||
      event.isComposing ||
      (!props.params.repository && !isWorktreeNameValid(liveWorktreeName))
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
      onInput={(event: Event) => {
        if (event.currentTarget instanceof HTMLInputElement) {
          clearActiveBranchSuggestion(
            event.currentTarget.closest(".new-session-page__branch-field"),
          );
          setSuggestionsOpen(true);
          props.params.onBaseRefInput(event.currentTarget.value);
        }
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
            onFocusOut={(event: FocusEvent) => {
              const field = event.currentTarget;
              if (
                field instanceof HTMLElement &&
                (!(event.relatedTarget instanceof Node) || !field.contains(event.relatedTarget))
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
                {
                  <For each={suggestions()} keyed={(branch) => branch.name}>
                    {(branch, index) => (
                      <button
                        id={`new-session-worktree-branch-suggestion-${index()}`}
                        type="button"
                        role="option"
                        aria-selected="false"
                        class="session-menu__item"
                        data-worktree-suggestion={branch().name}
                        tabindex="-1"
                        onMouseDown={(event: MouseEvent) => event.preventDefault()}
                        ref={nativeListener("click", () => {
                          props.params.onBaseRefInput(branch().name);
                          closeSuggestions();
                        })}
                      >
                        <span class="session-menu__text">{branch().name}</span>
                      </button>
                    )}
                  </For>
                }
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
              onInput={(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  props.params.onWorktreeNameInput(event.currentTarget.value);
                }
              }}
              ref={nativeListener("keydown", handleFieldKeydown)}
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
  let trigger!: HTMLButtonElement;
  let popover!: PopoverHandle;
  let confirmPending = false;
  return (
    <>
      <span class="new-session-page__select">
        <button
          id="new-session-checkout-trigger"
          ref={(node) => {
            trigger = node;
          }}
          type="button"
          class={[
            "new-session-page__trigger",
            { "new-session-page__trigger--hiding": props.params.popoverHiding },
          ]}
          title={`${t("newSession.checkout")}: ${props.params.state.label}`}
          aria-label={`${t("newSession.checkout")}: ${props.params.state.label}`}
          data-worktree={String(props.params.worktree)}
          aria-haspopup="dialog"
          aria-controls="new-session-checkout-popover"
          aria-expanded={props.params.popoverOpen ? "true" : "false"}
          disabled={props.params.submitting || props.params.pendingPlacement}
          onClick={(event) => {
            props.params.onGuardTransition(event);
            if (!event.defaultPrevented) {
              popover.overlay.request(!popover.overlay.open);
            }
          }}
        >
          <PickerLabel icon={<Icon name="gitBranch" />} label={props.params.state.label} />
        </button>
      </span>
      <PickerPopover
        ref={(handle) => {
          popover = handle;
        }}
        id="new-session-checkout-popover"
        label={`${t("newSession.checkout")}: ${props.params.state.label}`}
        anchor={trigger}
        class="new-session-page__select new-session-page__checkout-popover new-session-page__picker-popover"
        lifecycle={props.params}
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
                  checked: !props.params.worktree,
                  disabled: props.params.remotePlacement,
                  title: props.params.remotePlacement
                    ? t("newSession.checkoutRemoteLocked")
                    : undefined,
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
                    : props.params.repositoryUnavailable
                      ? t("newSession.gitCheckUnavailable")
                      : t("newSession.worktreeUnavailable"),
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
      </PickerPopover>
    </>
  );
}
