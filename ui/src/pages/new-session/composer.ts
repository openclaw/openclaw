import { html, nothing, type TemplateResult } from "lit";
import { guard } from "lit/directives/guard.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
} from "../../components/lobster-pet-contract.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../lib/ime.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { renderChatAttachmentInputs } from "../chat/components/chat-attachment-inputs.ts";
import {
  createChatAttachmentDropHandlers,
  handleChatAttachmentPaste,
  renderAttachmentPreview,
  renderAttachmentReadStatus,
} from "../chat/components/chat-attachments.ts";
import { adjustTextareaHeight, paneDomId } from "../chat/components/chat-composer-dom.ts";
import type { HumanMentionMenuHost } from "../chat/components/chat-composer-mention-menu.tsx";
import "../../components/tooltip.ts";
import { resolveComposerMenus } from "../chat/components/chat-composer-menus.ts";
import type { ChatComposerCapabilityMenuProps } from "../chat/components/chat-composer-plus-menu.tsx";
import { renderSelectedHumanMentions } from "../chat/components/chat-composer-selected-mentions.tsx";
import {
  handleSkillMenuKeydown,
  renderSkillMenu,
  resetSkillMenuState,
  updateSkillMenu,
  type SkillMenuHost,
} from "../chat/components/chat-composer-skill-menu.tsx";
import {
  handleSlashMenuKeydown,
  renderSlashMenu,
  resetSlashMenuState,
  type SlashMenuHost,
  updateSlashMenu,
} from "../chat/components/chat-composer-slash-menu.tsx";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import {
  renderNewSessionDraftVisibility,
  renderNewSessionPlusMenu,
  renderNewSessionSelectionStatus,
} from "./composer-capability-controls.ts";
import type { NewSessionComposerTextareaController } from "./composer-controller.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { resolveNewSessionMentionDirectory } from "./mention-directory.ts";
import type { NewSessionModelControl } from "./model-control.ts";

registerNewSessionSetupEnglish();

type NewSessionComposerOptions = {
  agent?: GatewayAgentRow;
  agentId: string;
  attachmentDraft: NewSessionAttachmentDraft;
  context: ApplicationContext | undefined;
  draftOwnerKey: string;
  isCatalogTarget: boolean;
  canSubmit: boolean;
  message: string;
  mentions?: readonly HumanMention[];
  getMentions?: () => readonly HumanMention[];
  modelControl: NewSessionModelControl;
  permissionControl?: TemplateResult | typeof nothing;
  requiresModifier: boolean;
  requestUpdate: () => void;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  dictationActive?: boolean;
  dictationPreview?: string;
  dictationStatus?: TemplateResult | typeof nothing;
  nativeTerminal?: boolean;
  onUnsupportedAttachment?: () => void;
  submitting: boolean;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: TemplateResult | typeof nothing;
  messageLocked?: boolean;
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: ChatComposerCapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  onInput: (message: string, mentions?: readonly HumanMention[]) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
  onBackgroundSubmit?: () => void;
};

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
  const busy = options.submitting || options.attachmentDraft.reads.pendingReads > 0;
  return html` <openclaw-tooltip content=${options.submitDisabledReason ?? startLabel}>
    <button
      type="button"
      class="chat-send-btn new-session-page__start-submit ${
        reasonedBlock ? "new-session-page__start-submit--blocked" : ""
      } ${busy ? "new-session-page__start-submit--busy" : ""}"
      ?disabled=${!options.canSubmit && !reasonedBlock}
      aria-disabled=${String(!options.canSubmit)}
      aria-busy=${String(busy)}
      aria-label=${startLabel}
      @click=${() => submitNewSession(options)}
    >
      ${busy ? icons.loader : options.nativeTerminal ? icons.squareTerminal : icons.arrowUp}
    </button>
  </openclaw-tooltip>`;
}

/** Draft message box styled as the chat composer shell so both pickers match. */
export function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const { attachmentDraft, context, textareaController } = options;
  const readSignal = attachmentDraft.reads.readSignal;
  const gateway = context?.gateway;
  const commandClient = options.nativeTerminal ? null : (gateway?.snapshot.client ?? null);
  const mentionDirectory = resolveNewSessionMentionDirectory(options);
  textareaController.syncSkillCommandOwner(commandClient, options.agentId, options.draftOwnerKey);
  const modelControl = options.isCatalogTarget
    ? nothing
    : options.modelControl.render({
        agent: options.agent,
        agentId: options.agentId,
        context,
        sending: options.submitting,
      });
  const skillMenuState = options.textareaController.skillMenuState;
  const slashMenuState = options.textareaController.slashMenuState;
  const mentionMenu = options.textareaController.mentionMenu;
  const emojiMenu = options.textareaController.emojiMenu;
  const composerLocked =
    options.submitting || options.messageLocked === true || options.dictationActive === true;
  mentionMenu.syncDirectory(composerLocked ? undefined : mentionDirectory);
  const skillMenuHost: SkillMenuHost = {
    paneId: "new-session",
    getDraft: () => options.textareaController.getTextarea()?.value ?? options.message,
    commitDraft: options.onInput,
    getTextarea: options.textareaController.getTextarea,
    refreshCommands: commandClient
      ? () =>
          refreshSlashCommands({
            client: commandClient,
            agentId: options.agentId,
            shouldApply: () =>
              textareaController.ownsSkillCommands(
                commandClient,
                options.agentId,
                options.draftOwnerKey,
              ),
          })
      : undefined,
  };
  const slashMenuHost: SlashMenuHost = {
    ...skillMenuHost,
    resolveArgOptions: (command) => command.argOptions ?? [],
    runCommand: () => submitNewSession(options),
    canRun: (inline) => !inline,
    commandFilter: (command) => command.executeLocal !== true,
  };
  const mentionMenuHost: HumanMentionMenuHost = {
    paneId: skillMenuHost.paneId,
    getDraft: skillMenuHost.getDraft,
    getTextarea: skillMenuHost.getTextarea,
    getMentions: () => options.getMentions?.() ?? options.mentions ?? [],
    commitDraft: options.onInput,
  };
  const handleComposerKeydown = (event: KeyboardEvent) => {
    if (
      options.dictationActive ||
      options.submitting ||
      options.messageLocked ||
      options.textareaController.composing ||
      isComposingKeyboardEvent(event)
    ) {
      return;
    }
    if (
      options.textareaController.emojiMenu.handleKeydown(
        event,
        "new-session",
        options.requestUpdate,
      ) ||
      options.textareaController.mentionMenu.handleKeydown(
        event,
        mentionMenuHost,
        options.requestUpdate,
      ) ||
      handleSkillMenuKeydown(
        event,
        options.textareaController.skillMenuState,
        skillMenuHost,
        options.requestUpdate,
      ) ||
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
    const isBackgroundShortcut = hasSubmitModifier && event.shiftKey;
    const background = Boolean(!event.altKey && isBackgroundShortcut && options.onBackgroundSubmit);
    if (!background && (event.shiftKey || (options.requiresModifier && !hasSubmitModifier))) {
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
      if (background) {
        resetSkillMenuState(options.textareaController.skillMenuState);
        resetSlashMenuState(options.textareaController.slashMenuState);
        options.textareaController.mentionMenu.close();
        options.onBackgroundSubmit?.();
      } else {
        submitNewSession(options);
      }
    }
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
    if (event?.inputType === "insertFromPaste" || event?.inputType === "insertFromDrop") {
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
    attachmentReads: attachmentDraft.reads,
    attachmentLimits: resolveChatAttachmentLimits(gateway?.snapshot.hello?.policy),
    uploadConfig: context?.config,
    attachments: attachmentDraft.attachments,
    get disabled() {
      return (
        options.submitting || options.messageLocked === true || options.dictationActive === true
      );
    },
    getAttachments: () => attachmentDraft.attachments,
    draft: options.message,
    getDraft: () => options.message,
    onAttachmentsChange: (attachments: typeof attachmentDraft.attachments) => {
      if (!options.submitting && !options.messageLocked) {
        attachmentDraft.replace(attachments);
      }
    },
    onDraftChange: options.onInput,
    onPendingReadsChange: (delta: 1 | -1) => attachmentDraft.reads.updatePending(readSignal, delta),
    onOpenImage: options.onOpenImage,
    onOpenSidebar: options.onOpenSidebar,
    readSignal,
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
  const ordinaryShortcut = options.requiresModifier
    ? "Control+Enter Meta+Enter"
    : "Enter Control+Enter Meta+Enter";
  const backgroundShortcut = "Control+Shift+Enter Meta+Shift+Enter";
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
        <openclaw-lobster-pet
          .seed=${lobsterPetSeed(`${textareaController.critterVisit}:${options.draftOwnerKey}`)}
          .mode=${resolveLobsterPetMode(!gateway?.snapshot.offlineStable, context?.sessions.state.result?.sessions)}
          .runOutcome=${resolveLobsterRunOutcome(context?.sessions.state.result?.sessions)}
          .visitsEnabled=${context?.theme.settings.lobsterPetVisits !== false}
          .residentEnabled=${context?.theme.branding.mascot !== "none"}
          .critters=${context?.theme.branding.critters}
          .critterArtwork=${context?.theme.branding.artwork?.critters}
          .soundsEnabled=${context?.theme.settings.lobsterPetSounds === true}
          .gatewayVersion=${context?.config.current.serverVersion ?? gateway?.snapshot.hello?.server?.version ?? null}
          .onVisitsDisabled=${() => context?.theme.refresh()}
          .floorEnabled=${
            !composerLocked &&
            visibleMessage.length === 0 &&
            attachmentDraft.attachments.length === 0 &&
            attachmentDraft.reads.pendingReads === 0 &&
            !menuVisible &&
            !textareaController.capabilityMenuOpen
          }
        ></openclaw-lobster-pet>
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
        ${renderAttachmentReadStatus(attachmentDraft.reads.pendingReads)}
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
              aria-haspopup=${ifDefined(menuVisible ? "listbox" : undefined)}
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
                clearCompositionEnd(event);
                emojiMenu.handleKeyup(event);
                if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                  handleSelect(event);
                }
              }}
              @blur=${(event: FocusEvent) => {
                clearCompositionEnd(event);
                const emojiWasOpen = emojiMenu.open;
                options.textareaController.composing = false;
                emojiMenu.close();
                if (emojiWasOpen) {
                  options.requestUpdate();
                }
              }}
              @compositionend=${(event: CompositionEvent) => {
                recordCompositionEnd(event);
                options.textareaController.composing = false;
                if (event.target instanceof HTMLTextAreaElement) {
                  updateMenus(event.target);
                }
              }}
              @keydown=${handleComposerKeydown}
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
            <span class="agent-chat__composer-placeholder" aria-hidden="true"
              >${animatedPlaceholder}</span
            >
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
                modelControl && modelControl !== nothing
                  ? html`<div class="chat-composer-model-control">${modelControl}</div>`
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
