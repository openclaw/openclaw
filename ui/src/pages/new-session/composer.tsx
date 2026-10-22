import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, onSettled, Show, useContext } from "solid-js";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createFooterControlRef } from "../../app/shell-layout-traits-solid.tsx";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterComposerElements,
} from "../../components/lobster-pet-contract.ts";
import { createBackgroundLayoutRef } from "../../components/session-background-layout-context.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isMobileBrowserPlatform, keepMobileReturnNative } from "../../lib/browser-platform.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import type { ComposerDraftSource } from "../../lib/chat/composer-draft-changes.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../lib/ime.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue as createLiveValue } from "../../lib/reactive/live-value.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { createChatAttachmentInputHandle } from "../chat/components/chat-attachment-inputs.ts";
import { ChatAttachmentInputs } from "../chat/components/chat-attachment-inputs.tsx";
import {
  createChatAttachmentDropHandlers,
  handleChatAttachmentPaste,
} from "../chat/components/chat-attachments.ts";
import { AttachmentPreview, AttachmentReadStatus } from "../chat/components/chat-attachments.tsx";
import {
  adjustTextareaHeight,
  handleTextareaOverflowInteraction,
  handleTextareaOverflowScroll,
  paneDomId,
} from "../chat/components/chat-composer-dom.ts";
import "../../components/tooltip.ts";
import { EmojiMenu } from "../chat/components/chat-composer-emoji.tsx";
import {
  HumanMentionMenuView,
  type HumanMentionMenuHost,
} from "../chat/components/chat-composer-mention-menu.tsx";
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
import { createComposerPlaceholder } from "./composer-placeholder.ts";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";
import type { NewSessionComposerTextarea } from "./composer-textarea.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { resolveNewSessionMentionDirectory } from "./mention-directory.ts";
import { NewSessionModelControlView } from "./model-control-view.tsx";
import type { NewSessionModelControl } from "./model-control.ts";

registerNewSessionSetupEnglish();

export type NewSessionComposerOptions = {
  agent?: GatewayAgentRow;
  agentId: string;
  attachmentDraft: NewSessionAttachmentDraft;
  draftSource?: ComposerDraftSource;
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

function submitNewSession(
  options: NewSessionComposerOptions,
  textarea: NewSessionComposerTextarea,
) {
  textarea.emojiMenu.close();
  textarea.mentionMenu.close();
  textarea.skillMenu.reset();
  textarea.slashMenu.reset();
  options.onSubmit();
}

/** Draft message box styled as the chat composer shell so both pickers match. */
function prepareComposer(options: NewSessionComposerOptions, textarea: NewSessionComposerTextarea) {
  const { attachmentDraft, context } = options;
  const readSignal = attachmentDraft.reads.readSignal;
  const gateway = context?.gateway;
  const commandClient = options.nativeTerminal ? null : (gateway?.snapshot.client ?? null);
  const mentionDirectory = resolveNewSessionMentionDirectory(options);
  const { skillMenu, slashMenu, mentionMenu, emojiMenu } = textarea;
  const skillMenuState = skillMenu.state;
  const slashMenuState = slashMenu.state;
  const composerLocked =
    options.submitting || options.messageLocked === true || options.dictationActive === true;
  const skillMenuHost: SkillMenuHost = {
    paneId: "new-session",
    getDraft: () => textarea.getTextarea()?.value ?? options.message,
    commitDraft: options.onInput,
    getTextarea: textarea.getTextarea,
    refreshCommands: commandClient
      ? () =>
          refreshSlashCommands({
            client: commandClient,
            agentId: options.agentId,
            shouldApply: () =>
              textarea.ownsSkillCommands(commandClient, options.agentId, options.draftOwnerKey),
          })
      : undefined,
  };
  const slashMenuHost: SlashMenuHost = {
    ...skillMenuHost,
    resolveArgOptions: (command) => command.argOptions ?? [],
    runCommand: () => submitNewSession(options, textarea),
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
      keepMobileReturnNative(event) ||
      options.dictationActive ||
      options.submitting ||
      options.messageLocked ||
      textarea.composing ||
      isComposingKeyboardEvent(event)
    ) {
      return;
    }
    if (
      textarea.emojiMenu.handleKeydown(event, "new-session") ||
      textarea.mentionMenu.handleKeydown(event, mentionMenuHost) ||
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
        textarea.skillMenu.reset();
        textarea.slashMenu.reset();
        textarea.mentionMenu.close();
        options.onBackgroundSubmit?.();
      } else {
        submitNewSession(options, textarea);
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
        !textarea.composing &&
        !commandsOpen &&
        !mentionMenu.open,
    );
  };
  const updateMenus = (target: HTMLTextAreaElement, event?: InputEvent) => {
    if (options.nativeTerminal || textarea.composing || event?.isComposing) {
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
  textarea.syncDraft(visibleMessage);
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
  const textarea = useContext(NewSessionComposerTextareaContext);
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
        onClick={() => submitNewSession(props.options, textarea)}
      >
        <Icon
          name={busy() ? "loader" : props.options.nativeTerminal ? "squareTerminal" : "arrowUp"}
        />
      </button>
    </openclaw-tooltip>
  );
}

export function NewSessionComposer(props: {
  options: NewSessionComposerOptions;
  surroundings?: () => Pick<LobsterComposerElements, "root" | "obstacles"> | undefined;
}) {
  const textarea = useContext(NewSessionComposerTextareaContext);
  const footerControl = createFooterControlRef();
  const inputHandle = createChatAttachmentInputHandle();
  const backgroundLayoutRef = createBackgroundLayoutRef("composer");
  const draft = createMemo(() => {
    const source = props.options.draftSource;
    return source ? projectOwner(source, (owner) => owner.read()) : undefined;
  });
  const options = createMemo(() => {
    const current = draft()?.read();
    return current
      ? { ...props.options, message: current.draft, mentions: current.mentions }
      : props.options;
  });
  const frame = createMemo(() => prepareComposer(options(), textarea));
  const placeholder = createComposerPlaceholder(options, textarea);
  // The textarea owner retires stale command requests and closes menus when its scope changes.
  createEffect(
    () =>
      [
        frame().commandClient,
        options().agentId,
        options().draftOwnerKey,
        frame().mentionDirectory,
        frame().composerLocked || options().nativeTerminal || textarea.composing,
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
  let input: HTMLTextAreaElement | undefined;
  let composer: HTMLDivElement | undefined;
  let footer: HTMLDivElement | undefined;
  let lead: HTMLDivElement | undefined;
  let model: HTMLDivElement | undefined;
  let actions: HTMLDivElement | undefined;
  const composerElements = (): LobsterComposerElements | null => {
    if (!composer || !input || !footer) {
      return null;
    }
    const surroundings = props.surroundings?.();
    return {
      root: surroundings?.root ?? composer,
      composer,
      editor: input,
      footer,
      controls: [lead, model, actions].filter(
        (element): element is HTMLDivElement => element?.isConnected === true,
      ),
      obstacles: surroundings?.obstacles ?? [],
    };
  };
  // A replacement can render before the old branch retires; claim only the committed input.
  onSettled(() => {
    textarea.ref(input);
    return () => textarea.ref();
  });
  return (
    <div
      ref={footerControl}
      class="agent-chat__composer-shell new-session-page__composer"
      onDrop={(event) => {
        if (options().nativeTerminal && event.dataTransfer?.files.length) {
          event.preventDefault();
          options().onUnsupportedAttachment?.();
        } else {
          frame().attachmentDropHandlers.onDrop(event);
        }
      }}
      onDragEnter={(event) => frame().attachmentDropHandlers.onDragenter(event)}
      onDragLeave={(event) => frame().attachmentDropHandlers.onDragleave(event)}
      onDragOver={(event) => frame().attachmentDropHandlers.onDragover(event)}
    >
      <div
        ref={(element) => {
          composer = element;
          backgroundLayoutRef(element);
        }}
        class={[
          "agent-chat__input agent-chat__input--mobile-toolbar",
          {
            "agent-chat__input--dictating": options().dictationActive,
          },
        ]}
        onOpenclaw-composer-dismiss-invocations={() => {
          textarea.mentionMenu.close();
          textarea.emojiMenu.dismiss(textarea.getTextarea());
          options().onChange();
        }}
      >
        <openclaw-lobster-pet
          prop:composerElements={composerElements}
          prop:seed={lobsterPetSeed(`${textarea.critterVisit}:${options().draftOwnerKey}`)}
          prop:mode={resolveLobsterPetMode(
            !options().context?.gateway.snapshot.offlineStable,
            options().context?.sessions.state.result?.sessions,
          )}
          prop:runOutcome={resolveLobsterRunOutcome(
            options().context?.sessions.state.result?.sessions,
          )}
          prop:visitsEnabled={options().context?.theme.settings.lobsterPetVisits !== false}
          prop:residentEnabled={options().context?.theme.branding.mascot !== "none"}
          prop:critters={options().context?.theme.branding.critters}
          prop:critterArtwork={options().context?.theme.branding.artwork?.critters}
          prop:soundsEnabled={options().context?.theme.settings.lobsterPetSounds === true}
          prop:gatewayVersion={
            options().context?.config.current.serverVersion ??
            options().context?.gateway.snapshot.hello?.server?.version ??
            null
          }
          prop:onVisitsDisabled={() => options().context?.theme.refresh()}
          prop:floorEnabled={
            !frame().composerLocked &&
            frame().visibleMessage.length === 0 &&
            options().attachmentDraft.attachments.length === 0 &&
            options().attachmentDraft.reads.pendingReads === 0 &&
            !frame().menuVisible &&
            !textarea.capabilityMenuOpen
          }
        />
        <HumanMentionMenuView args={[textarea.mentionMenu, frame().mentionMenuHost]} />
        <EmojiMenu args={[textarea.emojiMenu, "new-session", textarea.getTextarea()]} />
        <Show when={!options().nativeTerminal}>
          <ChatAttachmentInputs {...frame().attachmentProps} inputHandle={inputHandle} />
        </Show>
        <SelectedHumanMentions
          text={options().message}
          mentions={options().mentions}
          onRemove={() => options().onInput(options().message, [])}
          avatarUrls={textarea.mentionMenu.selectedAvatarUrls}
        />
        <AttachmentPreview {...frame().attachmentProps} readRevision={frame()} />
        <AttachmentReadStatus pendingReads={options().attachmentDraft.reads.pendingReads} />
        <div class="agent-chat__composer-lede">{options().dictationStatus}</div>
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            <Show when={frame().slashMenuVisible}>
              <SlashMenu
                menu={textarea.slashMenu}
                host={frame().slashMenuHost}
                draft={frame().visibleMessage}
              />
            </Show>
            <Show when={frame().skillMenuVisible}>
              <SkillMenu menu={textarea.skillMenu} host={frame().skillMenuHost} />
            </Show>
            <textarea
              ref={(element) => {
                input = element;
                messageValue(element);
              }}
              class="new-session-page__message"
              rows="1"
              autofocus={globalThis.matchMedia?.("(max-width: 560px)")?.matches ?? false}
              disabled={options().submitting || options().messageLocked}
              readonly={options().dictationActive}
              placeholder={placeholder()}
              aria-label={frame().messagePlaceholder}
              enterkeyhint="enter"
              aria-keyshortcuts={isMobileBrowserPlatform() ? undefined : frame().keyShortcuts}
              aria-autocomplete="list"
              aria-controls={frame().menuVisible ? frame().menuListboxId : undefined}
              aria-haspopup={frame().menuVisible ? "listbox" : undefined}
              aria-activedescendant={frame().activeMenuOptionId ?? undefined}
              aria-describedby={frame().menuAnnouncementId}
              onInput={(event) => {
                handleTextareaOverflowInteraction(event);
                if (options().dictationActive) {
                  return;
                }
                const target = event.currentTarget;
                adjustTextareaHeight(target, { nativeInput: true });
                const mentions = frame().mentionMenuHost.getMentions();
                options().onInput(
                  target.value,
                  mentions.length
                    ? updateHumanMentions(
                        options().message,
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
                handleTextareaOverflowInteraction(event);
                const target = event.currentTarget;
                textarea.mentionInput = {
                  value: target.value,
                  start: target.selectionStart,
                  end: target.selectionEnd,
                  inputType: event.inputType,
                };
                textarea.emojiMenu.complete(
                  event,
                  !frame().composerLocked && !options().nativeTerminal && !textarea.composing,
                );
              }}
              onScroll={handleTextareaOverflowScroll}
              onWheel={handleTextareaOverflowInteraction}
              onPointerDown={handleTextareaOverflowInteraction}
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
                handleTextareaOverflowInteraction(event);
                clearCompositionEnd(event);
                textarea.composing = false;
                textarea.emojiMenu.close();
              }}
              onCompositionEnd={(event) => {
                recordCompositionEnd(event);
                textarea.composing = false;
                frame().updateMenus(event.currentTarget);
              }}
              onKeyDown={(event) => {
                handleTextareaOverflowInteraction(event);
                frame().handleComposerKeydown(event);
              }}
              onCompositionStart={(event) => {
                handleTextareaOverflowInteraction(event);
                textarea.composing = true;
                textarea.emojiMenu.close();
                textarea.mentionMenu.close();
                options().onChange();
              }}
              onPaste={(event) => {
                if (options().nativeTerminal && event.clipboardData?.files.length) {
                  event.preventDefault();
                  options().onUnsupportedAttachment?.();
                } else if (!frame().composerLocked && !options().nativeTerminal) {
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
        <div class="agent-chat__composer-footer" ref={(element) => (footer = element)}>
          <div
            class="agent-chat__composer-lead"
            ref={(element) => {
              lead = element;
            }}
          >
            <Show when={!options().nativeTerminal}>
              <NewSessionPlusMenu
                options={options()}
                attachments={frame().attachmentProps}
                inputHandle={inputHandle}
              />
            </Show>
            {options().permissionControl}
            <Show when={!options().nativeTerminal && options().draftAvailable}>
              <NewSessionDraftVisibility options={options()} />
            </Show>
            <Show when={!options().nativeTerminal}>
              <NewSessionSelectionStatus options={options()} />
            </Show>
          </div>
          <div class="agent-chat__composer-trail">
            <div class="agent-chat__composer-controls">
              <Show when={!options().isCatalogTarget}>
                <div
                  class="chat-composer-model-control"
                  ref={(element) => {
                    model = element;
                  }}
                >
                  <NewSessionModelControlView
                    control={options().modelControl}
                    options={{
                      agent: options().agent,
                      agentId: options().agentId,
                      context: options().context,
                      sending: options().submitting,
                    }}
                  />
                </div>
              </Show>
            </div>
            <div
              class="agent-chat__composer-actions"
              ref={(element) => {
                actions = element;
              }}
            >
              {options().voiceControl}
              <Show when={!options().dictationActive}>
                <StartControl options={options()} />
              </Show>
            </div>
          </div>
        </div>
      </div>
      <Show when={options().blockedSubmitNotice}>
        <div
          class="new-session-page__blocked-submit agent-chat__composer-status"
          data-tone="info"
          role="status"
        >
          <div class="agent-chat__composer-status-band">
            <span class="agent-chat__composer-status-icon" aria-hidden="true">
              <Icon name="info" />
            </span>
            <span class="agent-chat__composer-status-text">{options().blockedSubmitNotice}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}
