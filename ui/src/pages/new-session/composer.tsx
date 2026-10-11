import type { JSX } from "@solidjs/web";
import { createMemo, onCleanup, Show, untrack } from "solid-js";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
} from "../../components/lobster-pet-contract.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../lib/ime.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue as createLiveValue } from "../../lib/reactive/live-value.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { LitContent } from "../../lit/solid-content.tsx";
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
import type { HumanMentionMenuHost } from "../chat/components/chat-composer-mention-menu.ts";
import "../../components/tooltip.ts";
import { resolveComposerMenus } from "../chat/components/chat-composer-menus.ts";
import type { ChatComposerCapabilityMenuProps } from "../chat/components/chat-composer-plus-menu.ts";
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
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import {
  NewSessionDraftVisibility,
  NewSessionPlusMenu,
  NewSessionSelectionStatus,
} from "./composer-capability-controls.tsx";
import type { NewSessionComposerTextareaController } from "./composer-controller.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { resolveNewSessionMentionDirectory } from "./mention-directory.ts";
import { NewSessionModelControlView } from "./model-control-view.tsx";
import type { NewSessionModelControl } from "./model-control.ts";

registerNewSessionSetupEnglish();

export type NewSessionComposerOptions = {
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
  permissionControl?: JSX.Element;
  requiresModifier: boolean;
  requestUpdate: () => void;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  dictationActive?: boolean;
  dictationPreview?: string;
  dictationStatus?: JSX.Element;
  nativeTerminal?: boolean;
  onUnsupportedAttachment?: () => void;
  submitting: boolean;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: JSX.Element;
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

/** Draft message box styled as the chat composer shell so both pickers match. */
function prepareNewSessionComposer(options: NewSessionComposerOptions) {
  const { attachmentDraft, context, textareaController } = options;
  const readSignal = attachmentDraft.reads.readSignal;
  const gateway = context?.gateway;
  const commandClient = options.nativeTerminal ? null : (gateway?.snapshot.client ?? null);
  const mentionDirectory = resolveNewSessionMentionDirectory(options);
  textareaController.syncSkillCommandOwner(commandClient, options.agentId, options.draftOwnerKey);
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
  return {
    attachmentProps,
    attachmentDropHandlers,
    composerLocked,
    visibleMessage,
    messagePlaceholder,
    animatedPlaceholder,
    keyShortcuts,
    skillMenuVisible,
    slashMenuVisible,
    menuVisible,
    menuListboxId,
    activeMenuOptionId,
    activeMenuOptionLabel,
    menuAnnouncementId,
    skillMenuHost,
    slashMenuHost,
    mentionMenuHost,
    handleComposerKeydown,
    handleSelect,
    updateMenus,
  };
}

function StartControl(props: { options: NewSessionComposerOptions }) {
  const label = () =>
    props.options.submitting
      ? t("newSession.starting")
      : t(props.options.nativeTerminal ? "newSession.startInTerminal" : "newSession.start");
  const reasonedBlock = () =>
    !props.options.canSubmit && props.options.submitDisabledReason !== undefined;
  const busy = () =>
    props.options.submitting || props.options.attachmentDraft.reads.pendingReads > 0;
  return (
    <openclaw-tooltip prop:content={props.options.submitDisabledReason ?? label()}>
      <button
        type="button"
        class={[
          "chat-send-btn new-session-page__start-submit",
          {
            "new-session-page__start-submit--blocked": reasonedBlock(),
            "new-session-page__start-submit--busy": busy(),
          },
        ]}
        disabled={!props.options.canSubmit && !reasonedBlock()}
        aria-disabled={props.options.canSubmit ? "false" : "true"}
        aria-busy={busy() ? "true" : "false"}
        aria-label={label()}
        onClick={() => submitNewSession(props.options)}
      >
        <Icon
          name={busy() ? "loader" : props.options.nativeTerminal ? "squareTerminal" : "arrowUp"}
        />
      </button>
    </openclaw-tooltip>
  );
}

/** The synchronous draft/controller owners prepare facts; Solid owns the persistent input DOM. */
export function NewSessionComposer(props: { options: NewSessionComposerOptions }) {
  const frame = createMemo(() => prepareNewSessionComposer(props.options));
  const textareaController = untrack(() => props.options.textareaController);
  const visibleMessage = createMemo(() => frame().visibleMessage);
  const messageValue = createLiveValue(visibleMessage);
  onCleanup(() => textareaController.ref());
  return (
    <div
      class="agent-chat__composer-shell new-session-page__composer"
      onDrop={(event) => {
        if (props.options.nativeTerminal && event.dataTransfer?.files.length) {
          event.preventDefault();
          props.options.onUnsupportedAttachment?.();
        } else {
          frame().attachmentDropHandlers.onDrop(event);
        }
      }}
      onDragEnter={(event) => frame().attachmentDropHandlers.onDragenter(event)}
      onDragLeave={(event) => frame().attachmentDropHandlers.onDragleave(event)}
      onDragOver={(event) => frame().attachmentDropHandlers.onDragover(event)}
    >
      <div
        class={[
          "agent-chat__input agent-chat__input--mobile-toolbar",
          {
            "agent-chat__input--dictating": props.options.dictationActive,
          },
        ]}
        onOpenclaw-composer-dismiss-invocations={() => {
          props.options.textareaController.mentionMenu.close();
          props.options.textareaController.emojiMenu.dismiss(
            props.options.textareaController.getTextarea(),
          );
          props.options.requestUpdate();
        }}
      >
        <openclaw-lobster-pet
          prop:seed={lobsterPetSeed(
            `${props.options.textareaController.critterVisit}:${props.options.draftOwnerKey}`,
          )}
          prop:mode={resolveLobsterPetMode(
            !props.options.context?.gateway.snapshot.offlineStable,
            props.options.context?.sessions.state.result?.sessions,
          )}
          prop:runOutcome={resolveLobsterRunOutcome(
            props.options.context?.sessions.state.result?.sessions,
          )}
          prop:visitsEnabled={props.options.context?.theme.settings.lobsterPetVisits !== false}
          prop:residentEnabled={props.options.context?.theme.branding.mascot !== "none"}
          prop:critters={props.options.context?.theme.branding.critters}
          prop:critterArtwork={props.options.context?.theme.branding.artwork?.critters}
          prop:soundsEnabled={props.options.context?.theme.settings.lobsterPetSounds === true}
          prop:gatewayVersion={
            props.options.context?.config.current.serverVersion ??
            props.options.context?.gateway.snapshot.hello?.server?.version ??
            null
          }
          prop:onVisitsDisabled={() => props.options.context?.theme.refresh()}
          prop:floorEnabled={
            !frame().composerLocked &&
            frame().visibleMessage.length === 0 &&
            props.options.attachmentDraft.attachments.length === 0 &&
            props.options.attachmentDraft.reads.pendingReads === 0 &&
            !frame().menuVisible &&
            !props.options.textareaController.capabilityMenuOpen
          }
        />
        <LitContent
          value={props.options.textareaController.mentionMenu.render(
            frame().mentionMenuHost,
            props.options.requestUpdate,
          )}
        />
        <LitContent
          value={props.options.textareaController.emojiMenu.render(
            "new-session",
            props.options.textareaController.getTextarea(),
            props.options.requestUpdate,
          )}
        />
        <Show when={!props.options.nativeTerminal}>
          <LitContent value={renderChatAttachmentInputs(frame().attachmentProps)} />
        </Show>
        <LitContent
          value={renderSelectedHumanMentions(
            props.options.message,
            props.options.mentions,
            () => props.options.onInput(props.options.message, []),
            props.options.textareaController.mentionMenu.selectedAvatarUrls,
          )}
        />
        <LitContent value={renderAttachmentPreview(frame().attachmentProps)} />
        <LitContent
          value={renderAttachmentReadStatus(props.options.attachmentDraft.reads.pendingReads)}
        />
        <div class="agent-chat__composer-lede">{props.options.dictationStatus}</div>
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            <Show when={frame().slashMenuVisible}>
              <LitContent
                value={renderSlashMenu(
                  props.options.textareaController.slashMenuState,
                  frame().slashMenuHost,
                  props.options.message,
                  props.options.requestUpdate,
                )}
              />
            </Show>
            <Show when={frame().skillMenuVisible}>
              <LitContent
                value={renderSkillMenu(
                  props.options.textareaController.skillMenuState,
                  frame().skillMenuHost,
                  props.options.requestUpdate,
                )}
              />
            </Show>
            <textarea
              ref={(element) => {
                textareaController.ref(element);
                messageValue(element);
              }}
              class="new-session-page__message"
              rows="1"
              autofocus={globalThis.matchMedia?.("(max-width: 560px)")?.matches ?? false}
              disabled={props.options.submitting || props.options.messageLocked}
              readonly={props.options.dictationActive}
              placeholder={frame().animatedPlaceholder}
              aria-label={frame().messagePlaceholder}
              aria-keyshortcuts={frame().keyShortcuts}
              aria-autocomplete="list"
              aria-controls={frame().menuVisible ? frame().menuListboxId : undefined}
              aria-haspopup={frame().menuVisible ? "listbox" : undefined}
              aria-activedescendant={frame().activeMenuOptionId ?? undefined}
              aria-describedby={frame().menuAnnouncementId}
              onInput={(event) => {
                if (props.options.dictationActive) {
                  return;
                }
                const target = event.currentTarget;
                adjustTextareaHeight(target);
                const mentions = frame().mentionMenuHost.getMentions();
                props.options.onInput(
                  target.value,
                  mentions.length
                    ? updateHumanMentions(
                        props.options.message,
                        target.value,
                        mentions,
                        props.options.textareaController.mentionInput,
                      )
                    : undefined,
                );
                props.options.textareaController.mentionInput = undefined;
                frame().updateMenus(target, event);
              }}
              onBeforeInput={(event) => {
                const target = event.currentTarget;
                props.options.textareaController.mentionInput = {
                  value: target.value,
                  start: target.selectionStart,
                  end: target.selectionEnd,
                  inputType: event.inputType,
                };
                props.options.textareaController.emojiMenu.complete(
                  event,
                  props.options.requestUpdate,
                  !frame().composerLocked &&
                    !props.options.nativeTerminal &&
                    !props.options.textareaController.composing,
                );
              }}
              onSelect={(event) => frame().handleSelect(event)}
              onFocus={(event) => frame().handleSelect(event)}
              onPointerUp={(event) => frame().handleSelect(event)}
              onKeyUp={(event) => {
                clearCompositionEnd(event);
                props.options.textareaController.emojiMenu.handleKeyup(event);
                if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                  frame().handleSelect(event);
                }
              }}
              onBlur={(event) => {
                clearCompositionEnd(event);
                const emojiWasOpen = props.options.textareaController.emojiMenu.open;
                props.options.textareaController.composing = false;
                props.options.textareaController.emojiMenu.close();
                if (emojiWasOpen) {
                  props.options.requestUpdate();
                }
              }}
              onCompositionEnd={(event) => {
                recordCompositionEnd(event);
                props.options.textareaController.composing = false;
                frame().updateMenus(event.currentTarget);
              }}
              onKeyDown={(event) => frame().handleComposerKeydown(event)}
              onCompositionStart={() => {
                props.options.textareaController.composing = true;
                props.options.textareaController.emojiMenu.close();
                props.options.textareaController.mentionMenu.close();
                props.options.requestUpdate();
              }}
              onPaste={(event) => {
                if (props.options.nativeTerminal && event.clipboardData?.files.length) {
                  event.preventDefault();
                  props.options.onUnsupportedAttachment?.();
                } else if (!frame().composerLocked && !props.options.nativeTerminal) {
                  handleChatAttachmentPaste(event, frame().attachmentProps);
                }
              }}
            />
            <span class="agent-chat__composer-placeholder" aria-hidden="true">
              {frame().animatedPlaceholder}
            </span>
            <span
              id={frame().menuAnnouncementId}
              class="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {frame().activeMenuOptionLabel}
            </span>
          </div>
        </div>
        <div class="agent-chat__composer-footer">
          <div class="agent-chat__composer-lead">
            <Show when={!props.options.nativeTerminal}>
              <NewSessionPlusMenu options={props.options} attachments={frame().attachmentProps} />
            </Show>
            {props.options.permissionControl}
            <Show when={!props.options.nativeTerminal && props.options.draftAvailable}>
              <NewSessionDraftVisibility options={props.options} />
            </Show>
            <Show when={!props.options.nativeTerminal}>
              <NewSessionSelectionStatus options={props.options} />
            </Show>
          </div>
          <div class="agent-chat__composer-trail">
            <div class="agent-chat__composer-controls">
              <Show when={!props.options.isCatalogTarget}>
                <div class="chat-composer-model-control">
                  <NewSessionModelControlView
                    control={props.options.modelControl}
                    options={{
                      agent: props.options.agent,
                      agentId: props.options.agentId,
                      context: props.options.context,
                      sending: props.options.submitting,
                    }}
                  />
                </div>
              </Show>
            </div>
            <div class="agent-chat__composer-actions">
              {props.options.voiceControl}
              <Show when={!props.options.dictationActive}>
                <StartControl options={props.options} />
              </Show>
            </div>
          </div>
        </div>
      </div>
      <Show when={props.options.blockedSubmitNotice}>
        <div
          class="new-session-page__blocked-submit agent-chat__composer-status"
          data-tone="info"
          role="status"
        >
          <div class="agent-chat__composer-status-band">
            <span class="agent-chat__composer-status-icon" aria-hidden="true">
              <Icon name="info" />
            </span>
            <span class="agent-chat__composer-status-text">
              {props.options.blockedSubmitNotice}
            </span>
          </div>
        </div>
      </Show>
    </div>
  );
}
