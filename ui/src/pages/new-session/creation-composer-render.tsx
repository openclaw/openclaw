import { createMemo, Show } from "solid-js";
import { createFooterControlRef } from "../../app/shell-layout-traits-solid.tsx";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { getChatComposerState } from "../chat/components/chat-composer-state.ts";
import { ChatComposer, resetChatComposerState } from "../chat/components/chat-composer.tsx";
import type { CreationComposer as CreationComposerOwner } from "./creation-composer.ts";

/** This view has no Gateway client: it can compose and stage, never execute session controls. */
function prepareCreationComposer(
  composer: CreationComposerOwner,
  onOpenImage: (item: ImageLightboxItem) => void,
): Parameters<typeof ChatComposer>[0] {
  const { context, attachmentDraft } = composer;
  const reads = attachmentDraft.reads;
  const signal = reads.readSignal;
  const paneId = "creation-" + composer.id;
  composer.releasePresentation = () => resetChatComposerState(paneId);
  composer.flushInput = () => {
    const textarea = getChatComposerState(paneId).composerTextarea;
    if (textarea?.isConnected && textarea.value !== composer.message) {
      composer.setMessage(textarea.value);
    }
  };
  return {
    paneId,
    sessionKey: paneId,
    currentAgentId: composer.agentId,
    connected: false,
    sessionAdmitted: false,
    canCompose: true,
    canSend: true,
    disabledReason: null,
    sending: false,
    messages: [],
    stream: null,
    queue: composer.inputs,
    draft: composer.message,
    draftSource: composer.composerDraft,
    getDraft: () => composer.message,
    mentions: composer.mentions,
    getMentions: () => composer.mentions,
    mentionsUnsupported: composer.incognito,
    modelCatalog: [],
    modelSwitching: false,
    sessions: null,
    assistantName: "",
    sendShortcut: context.theme?.settings.chatSendShortcut,
    uploadConfig: context.config,
    attachmentLimits: resolveChatAttachmentLimits(context.gateway.snapshot.hello?.policy),
    attachments: attachmentDraft.attachments,
    getAttachments: () => attachmentDraft.attachments,
    attachmentReads: reads,
    pendingAttachmentReads: reads.pendingReads,
    getPendingAttachmentReads: () => reads.pendingReads,
    readSignal: signal,
    onPendingReadsChange: (delta) => reads.updatePending(signal, delta),
    onAttachmentsChange: (attachments) => {
      if (composer.canDisplay()) {
        attachmentDraft.replace(attachments);
      }
    },
    onDraftChange: (message: string, mentions?: readonly HumanMention[]) =>
      composer.setMessage(message, mentions),
    onSend: () => {
      composer.enqueue();
    },
    onQueueRemove: (id) => composer.remove(id),
    onOpenImage,
  };
}

export function CreationComposer(props: {
  composer: CreationComposerOwner | undefined;
  onOpenImage: (item: ImageLightboxItem) => void;
}) {
  const owner = createMemo(() => {
    const composer = props.composer;
    return composer ? projectOwner(composer, (current) => current) : undefined;
  });
  const visible = createMemo(() => {
    const composer = owner()?.read();
    return composer?.canDisplay() ? composer : undefined;
  });
  return (
    <Show when={visible()} keyed>
      {(composer) => {
        const footerControl = createFooterControlRef();
        const prepared = createMemo(() => {
          owner()?.read();
          return prepareCreationComposer(composer, props.onOpenImage);
        });
        const error = createMemo(() => {
          owner()?.read();
          return composer.error;
        });
        return (
          <section
            ref={footerControl}
            class="creation-composer"
            aria-label={t("newSession.followUps")}
          >
            <Show when={error()}>
              <div class="callout danger" role="alert">
                {error()}
              </div>
            </Show>
            <ChatComposer {...prepared()} />
          </section>
        );
      }}
    </Show>
  );
}
