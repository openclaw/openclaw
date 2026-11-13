import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onSettled,
  Show,
  useContext,
} from "solid-js";
import { createFooterControlRef } from "../../app/shell-layout-traits-solid.tsx";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
  type LobsterComposerElements,
} from "../../components/lobster-pet-contract.ts";
import { createBackgroundLayoutRef } from "../../components/session-background-layout-context.tsx";
import { createSidebarRendererLoader } from "../../components/sidebar-renderer-loader.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { isMobileBrowserPlatform, keepMobileReturnNative } from "../../lib/browser-platform.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  composerInputHasFocus,
  focusComposerInput,
  syncComposerInput,
} from "../../lib/composer-input.ts";
import {
  clearCompositionEnd,
  isComposingKeyboardEvent,
  recordCompositionEnd,
} from "../../lib/ime.ts";
import { createMentionComposerBinding } from "../../lib/reactive/composer-editor.ts";
import { connectedElementRef } from "../../lib/reactive/element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue as createLiveValue } from "../../lib/reactive/live-value.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
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
import type { HumanMentionMenuHost } from "../chat/components/chat-composer-mention-menu-state.ts";
import { HumanMentionMenuView } from "../chat/components/chat-composer-mention-menu.tsx";
import { resolveComposerMenus } from "../chat/components/chat-composer-menus.ts";
import type { SkillMenuHost } from "../chat/components/chat-composer-skill-menu-state.ts";
import { SkillMenu } from "../chat/components/chat-composer-skill-menu.tsx";
import type { SlashMenuHost } from "../chat/components/chat-composer-slash-menu-state.ts";
import { SlashMenu } from "../chat/components/chat-composer-slash-menu.tsx";
import {
  ComposerWidthEdge,
  prepareComposerWidthEdge,
} from "../chat/components/chat-composer-width-ref.tsx";
import {
  NewSessionPlusMenu,
  NewSessionSelectionStatus,
  StartControl,
} from "./composer-capability-controls.tsx";
import type { NewSessionComposerOptions } from "./composer-options.ts";
import { createComposerPlaceholder } from "./composer-placeholder.ts";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";
import type { NewSessionComposerTextarea } from "./composer-textarea.ts";
import { resolveNewSessionMentionDirectory } from "./mention-directory.ts";
import { NewSessionModelControlView } from "./model-control-view.tsx";

registerNewSessionSetupEnglish();

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
    refreshCommands: commandClient ? () => textarea.refreshSkillCommands(commandClient) : undefined,
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
    // While plain Enter sends, the modified chord starts in the background like
    // the command palette. A modifier-enter preference keeps it for Send, so
    // Shift selects the background start there.
    const isBackgroundShortcut = hasSubmitModifier && (event.shiftKey || !options.requiresModifier);
    const background = Boolean(!event.altKey && isBackgroundShortcut && options.onBackgroundSubmit);
    if (!background && (event.shiftKey || (options.requiresModifier && !hasSubmitModifier))) {
      return;
    }
    if (event.repeat) {
      event.preventDefault();
      return;
    }
    // A reasoned gate consumes the press and reveals its explanation.
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

// Gate rendering, not a shared pending promise: drafts retired before idle
// must not leave lazy read callbacks retaining their DOM. Admission stays warm.
const [petAdmitted, admitPet] = createSignal(false);
const LobsterPet = lazy(() => import("../../components/lobster-pet.tsx"), {
  export: "LobsterPet",
});

type NewSessionComposerFrame = ReturnType<typeof prepareComposer>;

/** The draft-keyed field owns its editor/history; same-draft updates retain both. */
function NewSessionComposerInput(props: {
  options: NewSessionComposerOptions;
  frame: NewSessionComposerFrame;
  placeholder: string;
  input: ReturnType<typeof connectedElementRef<HTMLTextAreaElement>>;
}) {
  const textarea = useContext(NewSessionComposerTextareaContext);
  const messageValue = createLiveValue(() => props.frame.visibleMessage, syncComposerInput);
  const editorRef = createMentionComposerBinding(
    () => props.options.getMentions?.() ?? props.options.mentions ?? [],
    textarea.mentionMenu.selectedAvatarUrls,
  );
  let field: HTMLTextAreaElement | undefined;
  let releaseInput: (() => void) | undefined;
  let restoreFocus = false;
  onSettled(() => {
    textarea.ref(field);
    if (restoreFocus && document.activeElement === document.body) {
      focusComposerInput(field, { preventScroll: true });
    }
    return () => {
      if (textarea.getTextarea() === field) {
        textarea.ref();
      }
      releaseInput?.();
    };
  });
  return (
    <textarea
      data-composer-mentions={JSON.stringify(props.options.mentions ?? [])}
      ref={[
        (element) => {
          restoreFocus = composerInputHasFocus(props.input.read());
          releaseInput = props.input.bind(element);
          field = element;
          messageValue(element);
        },
        editorRef,
      ]}
      class="new-session-page__message"
      rows="1"
      autofocus={globalThis.matchMedia?.("(max-width: 560px)")?.matches ?? false}
      disabled={props.options.submitting || props.options.messageLocked}
      readonly={props.options.dictationActive}
      placeholder={props.placeholder}
      aria-label={props.frame.messagePlaceholder}
      enterkeyhint="enter"
      aria-keyshortcuts={isMobileBrowserPlatform() ? undefined : props.frame.keyShortcuts}
      aria-autocomplete="list"
      aria-controls={props.frame.menuVisible ? props.frame.menuListboxId : undefined}
      aria-haspopup={props.frame.menuVisible ? "listbox" : undefined}
      aria-activedescendant={props.frame.activeMenuOptionId ?? undefined}
      aria-describedby={props.frame.menuAnnouncementId}
      onInput={(event) => {
        handleTextareaOverflowInteraction(event);
        if (props.options.dictationActive) {
          return;
        }
        const target = event.currentTarget;
        adjustTextareaHeight(target, { nativeInput: true });
        const mentions = props.frame.mentionMenuHost.getMentions();
        const nextMentions = updateHumanMentions(
          props.options.message,
          target.value,
          mentions,
          textarea.mentionInput,
        );
        props.options.onInput(
          target.value,
          mentions.length || nextMentions.length ? nextMentions : undefined,
        );
        textarea.mentionInput = undefined;
        props.frame.updateMenus(target, event);
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
          !props.frame.composerLocked && !props.options.nativeTerminal && !textarea.composing,
        );
      }}
      onScroll={handleTextareaOverflowScroll}
      onWheel={handleTextareaOverflowInteraction}
      onPointerDown={handleTextareaOverflowInteraction}
      onSelect={(event) => props.frame.handleSelect(event)}
      onFocus={(event) => props.frame.handleSelect(event)}
      onPointerUp={(event) => props.frame.handleSelect(event)}
      onKeyUp={(event) => {
        clearCompositionEnd(event);
        textarea.emojiMenu.handleKeyup(event);
        if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
          props.frame.handleSelect(event);
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
        props.frame.updateMenus(event.currentTarget);
      }}
      onKeyDown={(event) => {
        handleTextareaOverflowInteraction(event);
        props.frame.handleComposerKeydown(event);
      }}
      onCompositionStart={(event) => {
        handleTextareaOverflowInteraction(event);
        textarea.composing = true;
        textarea.emojiMenu.close();
        textarea.mentionMenu.close();
        props.options.onChange();
      }}
      onPaste={(event) => {
        if (props.options.nativeTerminal && event.clipboardData?.files.length) {
          event.preventDefault();
          props.options.onUnsupportedAttachment?.();
        } else if (!props.frame.composerLocked && !props.options.nativeTerminal) {
          handleChatAttachmentPaste(event, props.frame.attachmentProps);
        }
      }}
    />
  );
}

export function NewSessionComposer(props: {
  options: NewSessionComposerOptions;
  surroundings?: () => Pick<LobsterComposerElements, "root" | "obstacles"> | undefined;
}) {
  const textarea = useContext(NewSessionComposerTextareaContext);
  const petLoader = createSidebarRendererLoader(async () => {
    admitPet(true);
    await LobsterPet.preload();
  });
  const PetBoundary = petLoader.Boundary;
  onSettled(() => {
    petLoader.schedule();
    return petLoader.dispose;
  });
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
        options().commandProjectId,
        frame().mentionDirectory,
        frame().composerLocked || options().nativeTerminal || textarea.composing,
      ] as const,
    ([client, agentId, draftOwnerKey, commandProjectId, directory, locked]) => {
      textarea.syncSkillCommandOwner(client, { agentId, draftOwnerKey, commandProjectId });
      textarea.mentionMenu.syncDirectory(directory);
      if (locked) {
        textarea.emojiMenu.close();
      }
    },
  );
  const input = connectedElementRef<HTMLTextAreaElement>();
  let composer: HTMLDivElement | undefined;
  let footer: HTMLDivElement | undefined;
  let lead: HTMLDivElement | undefined;
  let model: HTMLDivElement | undefined;
  let actions: HTMLDivElement | undefined;
  const composerElements = (): LobsterComposerElements | null => {
    const editor = input.read();
    if (!composer || !editor || !footer) {
      return null;
    }
    const surroundings = props.surroundings?.();
    return {
      root: surroundings?.root ?? composer,
      composer,
      editor,
      footer,
      controls: [lead, model, actions].filter(
        (element): element is HTMLDivElement => element?.isConnected === true,
      ),
      obstacles: surroundings?.obstacles ?? [],
    };
  };
  return (
    <div
      ref={footerControl}
      class="agent-chat__composer-shell new-session-page__composer"
      onPointerEnter={() => void prepareComposerWidthEdge()}
      onKeyDown={() => void prepareComposerWidthEdge()}
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
        <PetBoundary>
          <Show when={petAdmitted()}>
            <LobsterPet
              composerElements={composerElements}
              seed={lobsterPetSeed(`${textarea.critterVisit}:${options().draftOwnerKey}`)}
              mode={resolveLobsterPetMode(
                !options().context?.gateway.snapshot.offlineStable,
                options().context?.sessions.state.result?.sessions,
              )}
              runOutcome={resolveLobsterRunOutcome(
                options().context?.sessions.state.result?.sessions,
              )}
              visitsEnabled={options().context?.theme.settings.lobsterPetVisits !== false}
              residentEnabled={options().context?.theme.branding.mascot !== "none"}
              critters={options().context?.theme.branding.critters}
              critterArtwork={options().context?.theme.branding.artwork?.critters}
              soundsEnabled={options().context?.theme.settings.lobsterPetSounds === true}
              gatewayVersion={
                options().context?.config.current.serverVersion ??
                options().context?.gateway.snapshot.hello?.server?.version ??
                null
              }
              onVisitsDisabled={() => options().context?.theme.refresh()}
              floorEnabled={
                !frame().composerLocked &&
                frame().visibleMessage.length === 0 &&
                options().attachmentDraft.attachments.length === 0 &&
                options().attachmentDraft.reads.pendingReads === 0 &&
                !frame().menuVisible &&
                !textarea.capabilityMenuOpen
              }
            />
          </Show>
        </PetBoundary>
        <Show when={frame().slashMenuVisible}>
          <SlashMenu
            menu={textarea.slashMenu}
            host={frame().slashMenuHost}
            draft={frame().visibleMessage}
          />
        </Show>
        <HumanMentionMenuView args={[textarea.mentionMenu, frame().mentionMenuHost]} />
        <EmojiMenu args={[textarea.emojiMenu, "new-session", textarea.getTextarea()]} />
        <Show when={!options().nativeTerminal}>
          <ChatAttachmentInputs {...frame().attachmentProps} inputHandle={inputHandle} />
        </Show>
        <AttachmentPreview {...frame().attachmentProps} readRevision={frame()} />
        <AttachmentReadStatus pendingReads={options().attachmentDraft.reads.pendingReads} />
        <div class="agent-chat__composer-lede">{options().dictationStatus}</div>
        <div class="agent-chat__composer-input-row">
          <div class="agent-chat__composer-combobox">
            <Show when={frame().skillMenuVisible}>
              <SkillMenu menu={textarea.skillMenu} host={frame().skillMenuHost} />
            </Show>
            <Show when={options().draftOwnerKey} keyed>
              {(_draftOwnerKey) => (
                <NewSessionComposerInput
                  options={options()}
                  frame={frame()}
                  placeholder={placeholder()}
                  input={input}
                />
              )}
            </Show>
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
                <StartControl
                  options={options()}
                  onSubmit={() => submitNewSession(options(), textarea)}
                />
              </Show>
            </div>
          </div>
        </div>
      </div>
      <ComposerWidthEdge options={options} />
    </div>
  );
}
