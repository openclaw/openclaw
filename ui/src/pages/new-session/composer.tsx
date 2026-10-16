import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from "solid-js";
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
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { ChatAttachmentInputs } from "../chat/components/chat-attachment-inputs.tsx";
import {
  createChatAttachmentDropHandlers,
  handleChatAttachmentPaste,
} from "../chat/components/chat-attachments.ts";
import { AttachmentPreview, AttachmentReadStatus } from "../chat/components/chat-attachments.tsx";
import { adjustTextareaHeight, paneDomId } from "../chat/components/chat-composer-dom.ts";
import { EmojiMenu } from "../chat/components/chat-composer-emoji.tsx";
import {
  HumanMentionMenuView,
  type HumanMentionMenuHost,
} from "../chat/components/chat-composer-mention-menu.tsx";
import "../../components/tooltip.ts";
import { resolveComposerMenus } from "../chat/components/chat-composer-menus.ts";
import type { ChatComposerCapabilityMenuProps } from "../chat/components/chat-composer-plus-menu.types.ts";
import { SelectedHumanMentions } from "../chat/components/chat-composer-selected-mentions.tsx";
import { SkillMenu, type SkillMenuHost } from "../chat/components/chat-composer-skill-menu.tsx";
import { SlashMenu, type SlashMenuHost } from "../chat/components/chat-composer-slash-menu.tsx";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import {
  NewSessionDraftVisibility,
  NewSessionPlusMenu,
  NewSessionSelectionStatus,
} from "./composer-capability-controls.tsx";
import type { NewSessionComposerTextarea } from "./composer-controller.ts";
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
  onChange: () => void;
  submitDisabledReason?: string;
  blockedSubmitNotice?: string;
  dictationActive?: boolean;
  dictationPreview?: string;
  dictationStatus?: JSX.Element;
  nativeTerminal?: boolean;
  onUnsupportedAttachment?: () => void;
  submitting: boolean;
  textareaController: NewSessionComposerTextarea;
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
  options.textareaController.skillMenu.reset();
  options.textareaController.slashMenu.reset();
  options.onSubmit();
}

/** Draft message box styled as the chat composer shell so both pickers match. */
function prepareNewSessionComposer(options: NewSessionComposerOptions) {
  const { attachmentDraft, context, textareaController } = options;
  const readSignal = attachmentDraft.reads.readSignal;
  const gateway = context?.gateway;
  const commandClient = options.nativeTerminal ? null : (gateway?.snapshot.client ?? null);
  const mentionDirectory = resolveNewSessionMentionDirectory(options);
  const { skillMenu, slashMenu, mentionMenu, emojiMenu } = textareaController;
  const skillMenuState = skillMenu.state;
  const slashMenuState = slashMenu.state;
  const composerLocked =
    options.submitting || options.messageLocked === true || options.dictationActive === true;
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
      options.textareaController.emojiMenu.handleKeydown(event, "new-session") ||
      options.textareaController.mentionMenu.handleKeydown(event, mentionMenuHost) ||
      skillMenu.handleKeydown(event, skillMenuHost) ||
      slashMenu.handleKeydown(event, slashMenuHost)
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
        options.textareaController.skillMenu.reset();
        options.textareaController.slashMenu.reset();
        options.textareaController.mentionMenu.close();
        options.onBackgroundSubmit?.();
      } else {
        submitNewSession(options);
      }
    }
  };
  const updateEmojiMenu = (
    target: HTMLTextAreaElement,
    commandsOpen = skillMenuState.skillMenuOpen || slashMenuState.slashMenuOpen,
  ) => {
    emojiMenu.update(
      target,
      !composerLocked &&
        !options.nativeTerminal &&
        !options.textareaController.composing &&
        !commandsOpen &&
        !mentionMenu.open,
    );
  };
  const updateMenus = (target: HTMLTextAreaElement, event?: InputEvent) => {
    if (options.nativeTerminal || options.textareaController.composing || event?.isComposing) {
      emojiMenu.close();
      return;
    }
    const slashOpen = slashMenu.update(target.value, slashMenuHost);
    const skillOpen = skillMenu.update(target.value, target.selectionStart, skillMenuHost);
    if (event?.inputType === "insertFromPaste" || event?.inputType === "insertFromDrop") {
      mentionMenu.close();
    } else {
      mentionMenu.update(
        target,
        !event
          ? "selection"
          : event.inputType === "insertText" && event.data?.includes("@") === true
            ? "trigger"
            : "input",
      );
    }
    updateEmojiMenu(target, slashOpen || skillOpen);
  };
  const handleSelect = (event: Event) => {
    const target = event.currentTarget;
    if (target instanceof HTMLTextAreaElement) {
      if (event.type === "keyup") {
        mentionMenu.update(target);
        updateEmojiMenu(target);
      } else {
        updateMenus(target);
      }
    }
  };
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
  const keyShortcuts = options.onBackgroundSubmit
    ? `${ordinaryShortcut} Control+Shift+Enter Meta+Shift+Enter`
    : ordinaryShortcut;
  return {
    attachmentProps,
    attachmentDropHandlers,
    commandClient,
    mentionDirectory: composerLocked ? undefined : mentionDirectory,
    composerLocked,
    visibleMessage,
    messagePlaceholder,
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
    <openclaw-tooltip content={props.options.submitDisabledReason ?? label()}>
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

/** Animation belongs to the mounted input; menu and draft updates do not restart it. */
function createComposerPlaceholder(options: () => NewSessionComposerOptions) {
  const target = createMemo(() =>
    t(
      options().nativeTerminal
        ? "newSession.nativeTerminalPrompt"
        : "newSession.messagePlaceholder",
    ),
  );
  const hasMessage = createMemo(() => options().message.length > 0);
  const reducedMotion =
    !globalThis.requestAnimationFrame ||
    (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [frame, setFrame] = createSignal({ target: "", text: "" });
  let entered = false;
  // Restart the browser animation only when its text changes; typing cancels pending frames.
  createEffect(
    () => [target(), hasMessage()] as const,
    ([text, hasText]) => {
      entered ||= hasText;
      if (entered || reducedMotion) {
        return undefined;
      }
      let startedAt: number | undefined;
      let pending: number;
      let length = 0;
      const step = (timestamp: number) => {
        if (!options().textareaController.getTextarea()?.isConnected) {
          return;
        }
        startedAt ??= timestamp;
        const nextLength = Math.min(
          text.length,
          Math.floor(Math.max(0, timestamp - startedAt - 180) / 26),
        );
        entered = nextLength === text.length;
        if (length !== nextLength) {
          length = nextLength;
          setFrame({ target: text, text: text.slice(0, length) });
        }
        if (!entered) {
          pending = requestAnimationFrame(step);
        }
      };
      pending = requestAnimationFrame(step);
      return () => cancelAnimationFrame(pending);
    },
  );
  return () =>
    options().dictationActive
      ? ""
      : entered || hasMessage() || reducedMotion
        ? target()
        : frame().target === target()
          ? frame().text
          : "";
}

export function NewSessionComposer(props: { options: NewSessionComposerOptions }) {
  const frame = createMemo(() => prepareNewSessionComposer(props.options));
  const placeholder = createComposerPlaceholder(() => props.options);
  // The input and its synchronous owner share one mounted lifetime.
  const textarea = untrack(() => props.options.textareaController);
  createEffect(
    () =>
      [
        frame().commandClient,
        props.options.agentId,
        props.options.draftOwnerKey,
        frame().mentionDirectory,
        frame().composerLocked || props.options.nativeTerminal || textarea.composing,
      ] as const,
    ([client, agentId, draftOwnerKey, directory, locked]) => {
      textarea.syncSkillCommandOwner(client, agentId, draftOwnerKey);
      textarea.mentionMenu.syncDirectory(directory);
      if (locked) {
        textarea.emojiMenu.close();
      }
    },
  );
  const visibleMessage = createMemo(() => frame().visibleMessage);
  const messageValue = createLiveValue(visibleMessage);
  let input: HTMLTextAreaElement;
  // A replacement can render before the old branch retires; claim only the committed input.
  onSettled(() => {
    textarea.ref(input);
    return () => textarea.ref();
  });
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
          textarea.mentionMenu.close();
          textarea.emojiMenu.dismiss(textarea.getTextarea());
          props.options.onChange();
        }}
      >
        <openclaw-lobster-pet
          prop:seed={lobsterPetSeed(`${textarea.critterVisit}:${props.options.draftOwnerKey}`)}
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
            !textarea.capabilityMenuOpen
          }
        />
        <HumanMentionMenuView args={[textarea.mentionMenu, frame().mentionMenuHost]} />
        <EmojiMenu args={[textarea.emojiMenu, "new-session", textarea.getTextarea()]} />
        <Show when={!props.options.nativeTerminal}>
          <ChatAttachmentInputs {...frame().attachmentProps} />
        </Show>
        <SelectedHumanMentions
          text={props.options.message}
          mentions={props.options.mentions}
          onRemove={() => props.options.onInput(props.options.message, [])}
          avatarUrls={textarea.mentionMenu.selectedAvatarUrls}
        />
        <AttachmentPreview {...frame().attachmentProps} readRevision={frame()} />
        <AttachmentReadStatus pendingReads={props.options.attachmentDraft.reads.pendingReads} />
        <div class="agent-chat__composer-lede">{props.options.dictationStatus}</div>
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            <Show when={frame().slashMenuVisible}>
              <SlashMenu
                menu={props.options.textareaController.slashMenu}
                host={frame().slashMenuHost}
                draft={frame().visibleMessage}
              />
            </Show>
            <Show when={frame().skillMenuVisible}>
              <SkillMenu
                menu={props.options.textareaController.skillMenu}
                host={frame().skillMenuHost}
              />
            </Show>
            <textarea
              ref={(element) => {
                input = element;
                messageValue(element);
              }}
              class="new-session-page__message"
              rows="1"
              autofocus={globalThis.matchMedia?.("(max-width: 560px)")?.matches ?? false}
              disabled={props.options.submitting || props.options.messageLocked}
              readonly={props.options.dictationActive}
              placeholder={placeholder()}
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
                adjustTextareaHeight(target, { nativeInput: true });
                const mentions = frame().mentionMenuHost.getMentions();
                props.options.onInput(
                  target.value,
                  mentions.length
                    ? updateHumanMentions(
                        props.options.message,
                        target.value,
                        mentions,
                        textarea.mentionInput,
                      )
                    : undefined,
                );
                textarea.mentionInput = undefined;
                frame().updateMenus(target, event);
              }}
              onBeforeInput={(event) => {
                const target = event.currentTarget;
                textarea.mentionInput = {
                  value: target.value,
                  start: target.selectionStart,
                  end: target.selectionEnd,
                  inputType: event.inputType,
                };
                textarea.emojiMenu.complete(
                  event,
                  !frame().composerLocked && !props.options.nativeTerminal && !textarea.composing,
                );
              }}
              onSelect={(event) => frame().handleSelect(event)}
              onFocus={(event) => frame().handleSelect(event)}
              onPointerUp={(event) => frame().handleSelect(event)}
              onKeyUp={(event) => {
                clearCompositionEnd(event);
                textarea.emojiMenu.handleKeyup(event);
                if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                  frame().handleSelect(event);
                }
              }}
              onBlur={(event) => {
                clearCompositionEnd(event);
                textarea.composing = false;
                textarea.emojiMenu.close();
              }}
              onCompositionEnd={(event) => {
                recordCompositionEnd(event);
                textarea.composing = false;
                frame().updateMenus(event.currentTarget);
              }}
              onKeyDown={(event) => frame().handleComposerKeydown(event)}
              onCompositionStart={() => {
                textarea.composing = true;
                textarea.emojiMenu.close();
                textarea.mentionMenu.close();
                props.options.onChange();
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
              {placeholder()}
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
