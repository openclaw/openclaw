import { html, nothing } from "lit";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { t } from "../../i18n/index.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { getChatComposerState } from "../chat/components/chat-composer-state.ts";
import { renderChatComposer, resetChatComposerState } from "../chat/components/chat-composer.tsx";
import type { CreationComposer } from "./creation-composer.ts";

/** This view has no Gateway client: it can compose and stage, never execute session controls. */
export function renderCreationComposer(
  composer: CreationComposer | undefined,
  onOpenImage: (item: ImageLightboxItem) => void,
) {
  if (!composer?.canDisplay()) {
    return nothing;
  }
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
  return html`<section class="creation-composer" aria-label=${t("newSession.followUps")}>
    ${composer.error ? html`<div class="callout danger" role="alert">${composer.error}</div>` : nothing}
    ${renderChatComposer({
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
    })}
  </section>`;
}
