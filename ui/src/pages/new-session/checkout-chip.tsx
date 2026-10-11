import { createMemo, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import type { CheckoutChipOptions } from "./checkout-chip.ts";
import { SessionMenuItem } from "./cloud-target-view.tsx";
import { isWorktreeNameValid } from "./create-params.ts";
import { onOwnPopoverEvent } from "./new-session-runtime.ts";
import { PickerLabel } from "./picker-label.tsx";
let fieldDragging = false;

function handleFieldPointer(event: PointerEvent) {
  fieldDragging = event.type === "pointerdown";
}

function handlePopoverHide(event: Event, onHide: () => void) {
  if (event.target !== event.currentTarget) {
    return;
  }
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement &&
    fieldDragging &&
    active.selectionStart !== active.selectionEnd
  ) {
    fieldDragging = false;
    event.preventDefault();
    return;
  }
  onHide();
}

function clearActiveBranchSuggestion(field: Element | null) {
  field?.querySelector("input")?.removeAttribute("aria-activedescendant");
  for (const suggestion of field?.querySelectorAll("[data-worktree-suggestion]") ?? []) {
    suggestion.setAttribute("aria-selected", "false");
  }
}

function setBranchSuggestionsOpen(target: EventTarget | null, open: boolean) {
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const field = target.closest(".new-session-page__branch-field");
  field?.querySelector("wa-popup")?.toggleAttribute("active", open);
  const input = field?.querySelector("input");
  input?.setAttribute("aria-expanded", String(open));
  if (!open) {
    clearActiveBranchSuggestion(field);
  }
}

function handleBranchKeydown(target: HTMLElement, event: KeyboardEvent): boolean {
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
  setBranchSuggestionsOpen(target, true);
  return true;
}

function WorktreeFields(props: { params: CheckoutChipOptions }) {
  const handleFieldKeydown = (event: KeyboardEvent) => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    if (handleBranchKeydown(target, event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      target.closest("wa-popover")?.removeAttribute("open");
      return;
    }
    const popover = target.closest("wa-popover");
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
    fieldDragging = false;
    event.preventDefault();
    if (popover) {
      const confirmAfterOuterHide = (hideEvent: Event) => {
        if (hideEvent.target !== popover) {
          return;
        }
        popover.removeEventListener("wa-after-hide", confirmAfterOuterHide);
        props.params.onConfirm();
      };
      popover.addEventListener("wa-after-hide", confirmAfterOuterHide);
      popover.removeAttribute("open");
    }
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
      aria-expanded={suggestions().length ? "false" : undefined}
      disabled={props.params.submitting || props.params.pendingPlacement}
      placeholder={
        props.params.branchesLoading
          ? t("common.loading")
          : (props.params.branches?.defaultBranch ?? t("newSession.worktreeBaseRef"))
      }
      value={props.params.baseRef}
      onFocus={(event: FocusEvent) => setBranchSuggestionsOpen(event.currentTarget, true)}
      onInput={(event: Event) => {
        if (event.currentTarget instanceof HTMLInputElement) {
          clearActiveBranchSuggestion(
            event.currentTarget.closest(".new-session-page__branch-field"),
          );
          setBranchSuggestionsOpen(event.currentTarget, true);
          props.params.onBaseRefInput(event.currentTarget.value);
        }
      }}
      ref={nativeListener("keydown", handleFieldKeydown)}
      onPointerDown={handleFieldPointer}
      onPointerUp={handleFieldPointer}
      onPointerCancel={handleFieldPointer}
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
                setBranchSuggestionsOpen(field, false);
              }
            }}
          >
            {baseRefInput}
            <wa-popup
              class="new-session-page__branch-popup"
              anchor="new-session-worktree-base-ref"
              placement="bottom-start"
              sync="width"
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
                        ref={nativeListener("click", (event: MouseEvent) => {
                          props.params.onBaseRefInput(branch().name);
                          setBranchSuggestionsOpen(event.currentTarget, false);
                        })}
                      >
                        <span class="session-menu__text">{branch().name}</span>
                      </button>
                    )}
                  </For>
                }
              </div>
            </wa-popup>
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
              onPointerDown={handleFieldPointer}
              onPointerUp={handleFieldPointer}
              onPointerCancel={handleFieldPointer}
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
  return (
    <>
      <span class="new-session-page__select">
        <button
          id="new-session-checkout-trigger"
          type="button"
          class={[
            "new-session-page__trigger",
            { "new-session-page__trigger--hiding": props.params.popoverHiding },
          ]}
          title={`${t("newSession.checkout")}: ${props.params.state.label}`}
          aria-label={`${t("newSession.checkout")}: ${props.params.state.label}`}
          data-worktree={String(props.params.worktree)}
          aria-haspopup="dialog"
          aria-expanded={props.params.popoverOpen ? "true" : "false"}
          disabled={props.params.submitting || props.params.pendingPlacement}
          ref={nativeListener("click", (event) => props.params.onGuardTransition(event))}
        >
          <PickerLabel icon={<Icon name="gitBranch" />} label={props.params.state.label} />
        </button>
      </span>
      <wa-popover
        ref={syncPopoverLabel}
        class="new-session-page__select new-session-page__checkout-popover new-session-page__picker-popover"
        for="new-session-checkout-trigger"
        placement="bottom-start"
        without-arrow
        onWa-show={onOwnPopoverEvent(() => props.params.onPopoverShow())}
        onWa-hide={(event: Event) => handlePopoverHide(event, props.params.onPopoverHide)}
        onWa-after-hide={onOwnPopoverEvent(() => props.params.onPopoverAfterHide())}
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
            <WorktreeFields params={props.params} />
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
      </wa-popover>
    </>
  );
}
