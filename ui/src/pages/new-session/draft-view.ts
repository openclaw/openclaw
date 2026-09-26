import { html, nothing, type TemplateResult } from "lit";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { icons } from "../../components/icons.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { resolveGatewayStatus } from "../../lib/gateway-status.ts";
import { renderChatPermissionPicker } from "../chat/components/chat-permission-picker.ts";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import type { NewSessionDictationControl } from "./composer-dictation-control.ts";
import { renderNewSessionDraftComposer, renderNewSessionDraftErrors } from "./draft-composer.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionTitleController } from "./draft-title.ts";
import { renderNewSessionIncognitoNotice } from "./incognito-control.ts";

registerNewSessionSetupEnglish();

export function renderNewSessionDraftView(options: {
  context: ApplicationContext | undefined;
  gateway: DraftGatewayState;
  place: DraftPlaceState;
  submission: DraftSubmissionFlow;
  dictation: NewSessionDictationControl;
  titlePreparation: NewSessionTitleController;
  draftOwnerKey: string;
  isCatalogTarget: boolean;
  renderTargetBar: () => TemplateResult;
  requestUpdate: () => void;
  onMessage: (message: string, mentions?: readonly HumanMention[]) => void;
  onOpenImage: (item: ImageLightboxItem) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
}) {
  const {
    context,
    gateway,
    place,
    submission,
    dictation,
    titlePreparation,
    draftOwnerKey,
    isCatalogTarget,
    renderTargetBar,
    requestUpdate,
    onMessage,
    onOpenImage,
  } = options;
  const capabilities = submission.capabilities;
  const preferences = context?.theme.settings;
  const voiceControl = dictation.render(draftOwnerKey, preferences?.realtimeTalkInputDeviceId);
  const dictationLocked = dictation.active;
  const reconnecting = Boolean(
    context &&
    resolveGatewayStatus(
      context.gateway.snapshot,
      context.overlays.snapshot.controlUiRefreshRequired,
    ) === "reconnecting" &&
    !submission.submitting &&
    !submission.pendingPlacement.sessionKey &&
    !submission.submissionOutcomeUnknown,
  );
  return html`
    <div
      class="new-session-page__draft"
      aria-busy=${String(submission.submitting)}
      @compositionstart=${() => {
        titlePreparation.setComposing(true);
      }}
      @compositionend=${() => {
        titlePreparation.setComposing(false);
      }}
      @focusout=${() => {
        // Browsers can drop compositionend on blur/detach mid-IME; a stuck
        // composing flag would silently disable naming for the mounted page.
        titlePreparation.setComposing(false);
      }}
    >
      ${
        reconnecting
          ? html`<div class="new-session-page__reconnect-notice">
              <span aria-hidden="true">${icons.lock}</span>
              <div>
                <strong>${t("newSession.reconnectTitle")}</strong>
                <p>${t("newSession.reconnectDraftHint")}</p>
                <a href=${pathForRoute("chat", context?.basePath)}
                  >${t("newSession.readExistingChat")}</a
                >
              </div>
            </div>`
          : nothing
      }
      ${renderTargetBar()} ${renderNewSessionDraftErrors(place, submission, isCatalogTarget)}
      ${renderNewSessionDraftComposer({
        agent: place.selectedAgent(),
        agentId: place.agentId,
        attachmentDraft: submission.attachmentDraft,
        canSubmit: !submission.submitting && !dictationLocked && submission.canSubmit(),
        reconnecting,
        submitDisabledReason: submission.submitDisabledReason(),
        blockedSubmitNotice: submission.blockedSubmitNotice(),
        get dictationActive() {
          return dictation.active;
        },
        dictationPreview: dictation.previewDraft(),
        dictationStatus: dictation.renderStatus(),
        context,
        isCatalogTarget,
        draftOwnerKey,
        get message() {
          return submission.message;
        },
        mentions: submission.mentions,
        getMentions: () => submission.mentions,
        visibility: submission.visibility,
        draftAvailable: capabilities.canStartAsDraft(context),
        ...capabilities.composerProps(context, gateway, place.agentId),
        modelControl: place.modelControl,
        permissionControl: isCatalogTarget
          ? undefined
          : renderChatPermissionPicker({
              canSelectFull: place.isAdmin(),
              defaultMode: place.selectedAgent()?.defaultPermissionMode,
              disabled: submission.submitting || Boolean(submission.pendingPlacement.sessionKey),
              disabledReason: submission.submitting ? t("newSession.starting") : undefined,
              mode: submission.permission.value,
              onSelect: (permissionMode) => submission.permission.set(permissionMode ?? undefined),
            }),
        requiresModifier: preferences?.chatSendShortcut === "modifier-enter",
        requestUpdate,
        get submitting() {
          return submission.submitting;
        },
        textareaController: submission.composerTextarea,
        voiceControl,
        get messageLocked() {
          return Boolean(submission.pendingPlacement.sessionKey);
        },
        nativeTerminal: isCatalogTarget,
        onUnsupportedAttachment: () =>
          submission.setError(t("newSession.terminalAttachmentsUnsupported")),
        onInput: onMessage,
        onOpenImage,
        onOpenSidebar: options.onOpenSidebar,
        onVisibilityChange: (visibility) => {
          if (!submission.submitting && !submission.pendingPlacement.sessionKey) {
            submission.setVisibility(visibility);
          }
        },
        onSubmit: () => void submission.submit(),
        onBackgroundSubmit:
          submission.visibility === "draft" || isCatalogTarget
            ? undefined
            : () => void submission.submit(undefined, true),
      })}
      ${
        !isCatalogTarget
          ? renderNewSessionIncognitoNotice(submission.visibility === "incognito")
          : nothing
      }
    </div>
  `;
}
