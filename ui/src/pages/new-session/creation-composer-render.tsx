import { createMemo, Show } from "solid-js";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent, solidContent } from "../../lit/solid-content.tsx";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { getChatComposerState } from "../chat/components/chat-composer-state.ts";
import { renderChatComposer, resetChatComposerState } from "../chat/components/chat-composer.ts";
import type { CreationComposer as CreationComposerOwner } from "./creation-composer.ts";

/** This view has no Gateway client: it can compose and stage, never execute session controls. */
function prepareCreationComposer(
  composer: CreationComposerOwner,
  onOpenImage: (item: ImageLightboxItem) => void,
): Parameters<typeof renderChatComposer>[0] {
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
    onRequestUpdate: composer.notify,
  };
}

export function CreationComposer(props: {
  composer: CreationComposerOwner | undefined;
  onOpenImage: (item: ImageLightboxItem) => void;
  renderRevision?: object;
}) {
  const visible = createMemo(() => {
    void props.renderRevision;
    return props.composer?.canDisplay() ? props.composer : undefined;
  });
  return (
    <Show when={visible()}>
      {(composer) => (
        <CreationComposerContent
          composer={composer()}
          onOpenImage={props.onOpenImage}
          renderRevision={props.renderRevision}
        />
      )}
    </Show>
  );
}

function CreationComposerContent(props: {
  composer: CreationComposerOwner;
  onOpenImage: (item: ImageLightboxItem) => void;
  renderRevision?: object;
}) {
  const prepared = createMemo(() => {
    void props.renderRevision;
    return prepareCreationComposer(props.composer, props.onOpenImage);
  });
  const error = createMemo(() => {
    void props.renderRevision;
    return props.composer.error;
  });
  return (
    <section class="creation-composer" aria-label={t("newSession.followUps")}>
      <Show when={error()}>
        <div class="callout danger" role="alert">
          {props.composer.error}
        </div>
      </Show>
      <LitContent value={renderChatComposer(prepared())} />
    </section>
  );
}

export function renderCreationComposer(
  composer: CreationComposerOwner | undefined,
  onOpenImage: (item: ImageLightboxItem) => void,
) {
  return solidContent(CreationComposer, { composer, onOpenImage, renderRevision: {} });
}
