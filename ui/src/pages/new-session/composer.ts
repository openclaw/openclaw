import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import "../../components/tooltip.ts";
import {
  createChatAttachmentDropHandlers,
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderAttachmentReadStatus,
  renderChatAttachmentInputs,
} from "../chat/components/chat-attachments.ts";
import { adjustTextareaHeight, paneDomId } from "../chat/components/chat-composer-dom.ts";
import type { HumanMentionMenuHost } from "../chat/components/chat-composer-mention-menu.ts";
import { resolveComposerMenus } from "../chat/components/chat-composer-menus.ts";
import { renderSelectedHumanMentions } from "../chat/components/chat-composer-selected-mentions.ts";
import {
  handleSkillMenuKeydown,
  renderSkillMenu,
  resetSkillMenuState,
  updateSkillMenu,
  type SkillMenuHost,
} from "../chat/components/chat-composer-skill-menu.ts";
import {
  handleSlashMenuKeydown,
  renderSlashMenu,
  resetSlashMenuState,
  type SlashMenuHost,
  updateSlashMenu,
} from "../chat/components/chat-composer-slash-menu.ts";
import {
  renderNewSessionDraftVisibility,
  renderNewSessionPlusMenu,
  renderNewSessionSelectionStatus,
} from "./composer-capability-controls.ts";
import type { NewSessionComposerOptions } from "./composer-types.ts";

registerNewSessionSetupEnglish();

function submitNewSession(options: NewSessionComposerOptions) {
  options.textareaController.emojiMenu.close();
  options.textareaController.mentionMenu.close();
  resetSkillMenuState(options.textareaController.skillMenuState);
  resetSlashMenuState(options.textareaController.slashMenuState);
  options.onSubmit();
}

function renderStartControl(options: NewSessionComposerOptions) {
  const startLabel = options.submitting
    ? t("newSession.starting")
    : t(options.nativeTerminal ? "newSession.startInTerminal" : "newSession.start");
  const reasonedBlock = !options.canSubmit && options.submitDisabledReason !== undefined;
  return html` <openclaw-tooltip content=${options.submitDisabledReason ?? startLabel}>
    <button
      type="button"
      class="chat-send-btn new-session-page__start-submit ${
        reasonedBlock ? "new-session-page__start-submit--blocked" : ""
      }"
      ?disabled=${!options.canSubmit && !reasonedBlock}
      aria-disabled=${String(!options.canSubmit)}
      aria-busy=${String(options.submitting || options.pendingAttachmentReads > 0)}
      aria-label=${startLabel}
      @click=${() => submitNewSession(options)}
    >
      ${
        options.submitting || options.pendingAttachmentReads > 0
          ? icons.loader
          : options.nativeTerminal
            ? icons.squareTerminal
            : icons.arrowUp
      }
    </button>
  </openclaw-tooltip>`;
}

function handleComposerKeydown(
  event: KeyboardEvent,
  options: NewSessionComposerOptions,
  skillMenuHost: SkillMenuHost,
  slashMenuHost: SlashMenuHost,
  mentionMenuHost: HumanMentionMenuHost,
) {
  if (options.dictationActive || options.submitting || options.messageLocked) {
    return;
  }
  if (options.textareaController.composing || event.isComposing || event.keyCode === 229) {
    return;
  }
  if (
    options.textareaController.emojiMenu.handleKeydown(event, "new-session", options.requestUpdate)
  ) {
    return;
  }
  if (
    options.textareaController.mentionMenu.handleKeydown(
      event,
      mentionMenuHost,
      options.requestUpdate,
    )
  ) {
    return;
  }
  if (
    handleSkillMenuKeydown(
      event,
      options.textareaController.skillMenuState,
      skillMenuHost,
      options.requestUpdate,
    )
  ) {
    return;
  }
  if (
    handleSlashMenuKeydown(
      event,
      options.textareaController.slashMenuState,
      slashMenuHost,
      options.requestUpdate,
    )
  ) {
    return;
  }
  if (event.key !== "Enter") {
    return;
  }
  const hasSubmitModifier = event.metaKey || event.ctrlKey;
  const isBackgroundShortcut = options.requiresModifier
    ? hasSubmitModifier && event.shiftKey
    : hasSubmitModifier && !event.shiftKey;
  if (!event.altKey && isBackgroundShortcut && options.onBackgroundSubmit) {
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    if (options.canSubmit || options.submitDisabledReason !== undefined) {
      event.preventDefault();
      resetSkillMenuState(options.textareaController.skillMenuState);
      resetSlashMenuState(options.textareaController.slashMenuState);
      options.textareaController.mentionMenu.close();
      options.onBackgroundSubmit();
    }
    return;
  }
  if (event.shiftKey || (options.requiresModifier && !hasSubmitModifier)) {
    return;
  }
  if (event.repeat) {
    event.preventDefault();
    return;
  }
  // A reasoned gate still consumes the press: the submission flow records the
  // attempt and surfaces the reason instead of silently inserting a newline.
  // Only silent gates (busy button, empty draft) keep Enter native.
  if (options.canSubmit || options.submitDisabledReason !== undefined) {
    event.preventDefault();
    submitNewSession(options);
  }
}

/** Draft message box styled as the chat composer shell so both pickers match. */
export function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const skillMenuState = options.textareaController.skillMenuState;
  const slashMenuState = options.textareaController.slashMenuState;
  const mentionMenu = options.textareaController.mentionMenu;
  const emojiMenu = options.textareaController.emojiMenu;
  const composerLocked =
    options.submitting || options.messageLocked === true || options.dictationActive === true;
  mentionMenu.syncDirectory(
    options.submitting || options.messageLocked || options.dictationActive
      ? undefined
      : options.mentionDirectory,
  );
  const skillMenuHost: SkillMenuHost = {
    paneId: "new-session",
    getDraft: () => options.textareaController.getTextarea()?.value ?? options.message,
    commitDraft: options.onInput,
    getTextarea: options.textareaController.getTextarea,
    refreshCommands: options.refreshCommands,
  };
  const slashMenuHost: SlashMenuHost = {
    paneId: skillMenuHost.paneId,
    getDraft: skillMenuHost.getDraft,
    commitDraft: skillMenuHost.commitDraft,
    getTextarea: skillMenuHost.getTextarea,
    resolveArgOptions: (command) => command.argOptions ?? [],
    runCommand: () => submitNewSession(options),
    canRun: (inline) => !inline,
    refreshCommands: options.refreshCommands,
    commandFilter: (command) => command.executeLocal !== true,
  };
  const mentionMenuHost: HumanMentionMenuHost = {
    paneId: skillMenuHost.paneId,
    getDraft: skillMenuHost.getDraft,
    getTextarea: skillMenuHost.getTextarea,
    getMentions: () => options.getMentions?.() ?? options.mentions ?? [],
    commitDraft: options.onInput,
  };
  const updateEmojiMenu = (target: HTMLTextAreaElement) => {
    emojiMenu.update(
      target,
      options.requestUpdate,
      !composerLocked &&
        !options.nativeTerminal &&
        !options.textareaController.composing &&
        !skillMenuState.skillMenuOpen &&
        !slashMenuState.slashMenuOpen &&
        !mentionMenu.open,
    );
  };
  const updateMenus = (target: HTMLTextAreaElement, event?: InputEvent) => {
    if (options.nativeTerminal || options.textareaController.composing || event?.isComposing) {
      emojiMenu.close();
      return;
    }
    updateSlashMenu(target.value, slashMenuState, slashMenuHost, options.requestUpdate);
    updateSkillMenu(
      target.value,
      target.selectionStart,
      skillMenuState,
      skillMenuHost,
      options.requestUpdate,
    );
    if (
      event?.inputType === "insertFromPaste" ||
      event?.inputType === "insertFromDrop" ||
      event?.isComposing
    ) {
      mentionMenu.close();
    } else {
      mentionMenu.update(
        target,
        options.requestUpdate,
        !event
          ? "selection"
          : event.inputType === "insertText" && event.data?.includes("@") === true
            ? "trigger"
            : "input",
      );
    }
    updateEmojiMenu(target);
  };
  const handleSelect = (event: Event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      if (event.type === "keyup") {
        mentionMenu.update(target, options.requestUpdate);
        updateEmojiMenu(target);
      } else {
        updateMenus(target);
      }
    }
  };
  if (composerLocked || options.nativeTerminal || options.textareaController.composing) {
    emojiMenu.close();
  }
  const attachmentProps = {
    attachmentReads: options.attachmentReads,
    attachmentLimits: options.attachmentLimits,
    attachments: options.attachments,
    get disabled() {
      return (
        options.submitting || options.messageLocked === true || options.dictationActive === true
      );
    },
    getAttachments: options.getAttachments,
    draft: options.message,
    getDraft: () => options.message,
    onAttachmentsChange: options.onAttachmentsChange,
    onDraftChange: options.onInput,
    onPendingReadsChange: options.onPendingReadsChange,
    onOpenImage: options.onOpenImage,
    onOpenSidebar: options.onOpenSidebar,
    readSignal: options.readSignal,
  };
  const attachmentDropHandlers = createChatAttachmentDropHandlers({
    ...attachmentProps,
    canCompose: !composerLocked && !options.nativeTerminal,
  });
  const visibleMessage = options.dictationPreview ?? options.message;
  options.textareaController.syncDraft(visibleMessage);
  const messagePlaceholder = t(
    options.nativeTerminal ? "newSession.nativeTerminalPrompt" : "newSession.messagePlaceholder",
  );
  const animatedPlaceholder = options.dictationActive
    ? ""
    : options.textareaController.getPlaceholder(
        messagePlaceholder,
        options.message,
        options.requestUpdate,
      );
  const {
    skillMenuVisible,
    slashMenuVisible,
    menuVisible,
    menuListboxId,
    activeMenuOptionId,
    activeMenuOptionLabel,
  } = resolveComposerMenus(
    skillMenuHost.paneId,
    !options.nativeTerminal && !composerLocked,
    skillMenuState,
    slashMenuState,
    mentionMenu,
    emojiMenu,
  );
  const menuAnnouncementId = paneDomId(skillMenuHost.paneId, "active-menu-announcement");
  const ordinaryShortcut = options.requiresModifier ? "Control+Enter Meta+Enter" : "Enter";
  const backgroundShortcut = options.requiresModifier
    ? "Control+Shift+Enter Meta+Shift+Enter"
    : "Control+Enter Meta+Enter";
  const keyShortcuts = options.onBackgroundSubmit
    ? `${ordinaryShortcut} ${backgroundShortcut}`
    : ordinaryShortcut;
  return html`
    <div
      class="agent-chat__composer-shell new-session-page__composer"
      @drop=${(event: DragEvent) => {
        if (options.nativeTerminal && event.dataTransfer?.files.length) {
          event.preventDefault();
          options.onUnsupportedAttachment?.();
        } else {
          attachmentDropHandlers.onDrop(event);
        }
      }}
      @dragenter=${attachmentDropHandlers.onDragenter}
      @dragleave=${attachmentDropHandlers.onDragleave}
      @dragover=${attachmentDropHandlers.onDragover}
    >
      <div
        class="agent-chat__input agent-chat__input--mobile-toolbar${
          options.dictationActive ? " agent-chat__input--dictating" : ""
        }"
        @openclaw-composer-dismiss-invocations=${() => {
          mentionMenu.close();
          emojiMenu.dismiss(options.textareaController.getTextarea());
          options.requestUpdate();
        }}
      >
        ${options.renderCritters(
          !composerLocked &&
            visibleMessage.length === 0 &&
            options.attachments.length === 0 &&
            options.pendingAttachmentReads === 0 &&
            !menuVisible &&
            !options.textareaController.capabilityMenuOpen,
        )}
        ${mentionMenu.render(mentionMenuHost, options.requestUpdate)}
        ${emojiMenu.render("new-session", options.textareaController.getTextarea(), options.requestUpdate)}
        ${options.nativeTerminal ? nothing : renderChatAttachmentInputs(attachmentProps)}
        ${renderSelectedHumanMentions(
          options.message,
          options.mentions,
          () => options.onInput(options.message, []),
          mentionMenu.selectedAvatarUrls,
        )}
        ${renderAttachmentPreview(attachmentProps)}
        ${renderAttachmentReadStatus(options.pendingAttachmentReads)}
        <div class="agent-chat__composer-lede">${options.dictationStatus ?? nothing}</div>
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            ${
              slashMenuVisible
                ? renderSlashMenu(
                    slashMenuState,
                    slashMenuHost,
                    options.message,
                    options.requestUpdate,
                  )
                : nothing
            }
            ${
              skillMenuVisible
                ? renderSkillMenu(skillMenuState, skillMenuHost, options.requestUpdate)
                : nothing
            }
            <textarea
              ${ref(options.textareaController.ref)}
              class="new-session-page__message"
              rows="1"
              ?autofocus=${globalThis.matchMedia?.("(max-width: 560px)")?.matches ?? false}
              ?disabled=${options.submitting || options.messageLocked}
              ?readonly=${options.dictationActive}
              placeholder=${animatedPlaceholder}
              aria-label=${messagePlaceholder}
              aria-keyshortcuts=${keyShortcuts}
              .value=${guard([visibleMessage], () => live(visibleMessage))}
              aria-autocomplete="list"
              aria-controls=${ifDefined(menuVisible ? menuListboxId : undefined)}
              aria-expanded=${ifDefined(menuVisible ? "true" : undefined)}
              aria-activedescendant=${ifDefined(activeMenuOptionId ?? undefined)}
              aria-describedby=${menuAnnouncementId}
              @input=${(event: InputEvent) => {
                if (options.dictationActive) {
                  return;
                }
                // SAFETY: this input listener is attached directly to the textarea below.
                const target = event.target as HTMLTextAreaElement;
                adjustTextareaHeight(target);
                const mentions = mentionMenuHost.getMentions();
                options.onInput(
                  target.value,
                  mentions.length
                    ? updateHumanMentions(
                        options.message,
                        target.value,
                        mentions,
                        options.textareaController.mentionInput,
                      )
                    : undefined,
                );
                options.textareaController.mentionInput = undefined;
                updateMenus(target, event);
              }}
              @beforeinput=${(event: InputEvent) => {
                // SAFETY: this beforeinput listener belongs to this native textarea.
                const target = event.target as HTMLTextAreaElement;
                options.textareaController.mentionInput = {
                  value: target.value,
                  start: target.selectionStart,
                  end: target.selectionEnd,
                  inputType: event.inputType,
                };
                emojiMenu.complete(
                  event,
                  options.requestUpdate,
                  !composerLocked &&
                    !options.nativeTerminal &&
                    !options.textareaController.composing,
                );
              }}
              @select=${handleSelect}
              @focus=${handleSelect}
              @pointerup=${handleSelect}
              @keyup=${(event: KeyboardEvent) => {
                emojiMenu.handleKeyup(event);
                if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                  handleSelect(event);
                }
              }}
              @blur=${() => {
                const emojiWasOpen = emojiMenu.open;
                options.textareaController.composing = false;
                emojiMenu.close();
                if (emojiWasOpen) {
                  options.requestUpdate();
                }
              }}
              @compositionend=${(event: CompositionEvent) => {
                options.textareaController.composing = false;
                if (event.target instanceof HTMLTextAreaElement) {
                  updateMenus(event.target);
                }
              }}
              @keydown=${(event: KeyboardEvent) =>
                handleComposerKeydown(
                  event,
                  options,
                  skillMenuHost,
                  slashMenuHost,
                  mentionMenuHost,
                )}
              @compositionstart=${() => {
                options.textareaController.composing = true;
                emojiMenu.close();
                mentionMenu.close();
                options.requestUpdate();
              }}
              @paste=${(event: ClipboardEvent) => {
                if (options.nativeTerminal && event.clipboardData?.files.length) {
                  event.preventDefault();
                  options.onUnsupportedAttachment?.();
                } else if (!composerLocked && !options.nativeTerminal) {
                  handleChatAttachmentPaste(event, attachmentProps);
                }
              }}
            ></textarea>
            <span
              id=${menuAnnouncementId}
              class="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
              >${activeMenuOptionLabel}</span
            >
          </div>
        </div>
        <div class="agent-chat__composer-footer">
          <div class="agent-chat__composer-lead">
            ${options.nativeTerminal ? nothing : renderNewSessionPlusMenu(options, attachmentProps)}
            ${options.permissionControl ?? nothing}
            ${
              !options.nativeTerminal && options.draftAvailable
                ? renderNewSessionDraftVisibility(options)
                : nothing
            }
            ${options.nativeTerminal ? nothing : renderNewSessionSelectionStatus(options)}
          </div>
          <div class="agent-chat__composer-trail">
            <div class="agent-chat__composer-controls">
              ${
                options.modelControl && options.modelControl !== nothing
                  ? html`<div class="chat-composer-model-control">${options.modelControl}</div>`
                  : nothing
              }
            </div>
            <div class="agent-chat__composer-actions">
              ${options.voiceControl ?? nothing}${
                options.dictationActive ? nothing : renderStartControl(options)
              }
            </div>
          </div>
        </div>
      </div>
      ${
        options.blockedSubmitNotice
          ? html`<div
              class="new-session-page__blocked-submit agent-chat__composer-status"
              data-tone="info"
              role="status"
            >
              <div class="agent-chat__composer-status-band">
                <span class="agent-chat__composer-status-icon" aria-hidden="true"
                  >${icons.info}</span
                >
                <span class="agent-chat__composer-status-text">${options.blockedSubmitNotice}</span>
              </div>
            </div>`
          : nothing
      }
    </div>
  `;
}
