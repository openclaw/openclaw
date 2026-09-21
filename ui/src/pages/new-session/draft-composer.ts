import { html, nothing, type TemplateResult } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
} from "../../components/lobster-pet-contract.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import type { CapabilityMenuProps } from "../chat/components/chat-composer-types.ts";
import type { SidebarContent } from "../chat/components/chat-sidebar-content-types.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaController } from "./composer-controller.ts";
import { renderNewSessionComposer } from "./composer.ts";
import { isWorktreeNameValid, type NewSessionVisibility } from "./create-params.ts";
import { renderDraftError } from "./draft-body.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import { resolveNewSessionMentionDirectory } from "./mention-directory.ts";
import type { NewSessionModelControl } from "./model-control.ts";

registerNewSessionSetupEnglish();

export function renderNewSessionDraftErrors(
  place: Pick<DraftPlaceState, "worktree" | "worktreeName">,
  submission: Pick<
    DraftSubmissionFlow,
    | "submissionOutcomeUnknown"
    | "pendingPlacement"
    | "clearPendingPlacementRecovery"
    | "capabilities"
  >,
  isCatalogTarget: boolean,
) {
  const worktreeNameInvalid = place.worktree && !isWorktreeNameValid(place.worktreeName);
  const capabilities = submission.capabilities;
  return html`
    ${worktreeNameInvalid ? renderDraftError(t("newSession.worktreeNameInvalid")) : nothing}
    ${
      isCatalogTarget && capabilities.toolOverrides
        ? renderDraftError(t("newSession.terminalCapabilityOverridesUnsupported"), {
            label: t("common.reset"),
            onClick: () => capabilities.setToolOverrides(null),
          })
        : nothing
    }
    ${
      submission.submissionOutcomeUnknown
        ? renderDraftError(
            t(
              submission.submissionOutcomeUnknown === "gateway-changed"
                ? "newSession.createOutcomeUnknown"
                : "newSession.placementSetupInterrupted",
            ),
            submission.pendingPlacement.sessionKey
              ? {
                  label: t("common.reset"),
                  onClick: () => submission.clearPendingPlacementRecovery(),
                }
              : undefined,
          )
        : nothing
    }
  `;
}

export function renderNewSessionDraftComposer(options: {
  agent?: GatewayAgentRow;
  agentId: string;
  attachmentDraft: NewSessionAttachmentDraft;
  canSubmit: boolean;
  context: ApplicationContext | undefined;
  draftOwnerKey: string;
  isCatalogTarget: boolean;
  message: string;
  mentions?: readonly HumanMention[];
  getMentions?: () => readonly HumanMention[];
  visibility?: NewSessionVisibility;
  draftAvailable?: boolean;
  capabilityMenu?: CapabilityMenuProps;
  toolOverrides?: SessionToolOverrides | null;
  modelControl: NewSessionModelControl;
  permissionControl?: TemplateResult;
  textareaController: NewSessionComposerTextareaController;
  voiceControl?: TemplateResult | typeof nothing;
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
  messageLocked?: boolean;
  onInput: (message: string, mentions?: readonly HumanMention[]) => void;
  onOpenImage?: (item: ImageLightboxItem) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onVisibilityChange?: (visibility: NewSessionVisibility) => void;
  onSubmit: () => void;
  onBackgroundSubmit?: () => void;
}) {
  const readSignal = options.attachmentDraft.readSignal;
  const commandClient = options.nativeTerminal
    ? null
    : (options.context?.gateway.snapshot.client ?? null);
  const gateway = options.context?.gateway;
  const mentionDirectory = resolveNewSessionMentionDirectory(options);
  options.textareaController.syncSkillCommandOwner(
    commandClient,
    options.agentId,
    options.draftOwnerKey,
  );
  return renderNewSessionComposer({
    renderCritters: (floorEnabled) => html`<openclaw-lobster-pet
      .seed=${lobsterPetSeed(`${options.textareaController.critterVisit}:${options.draftOwnerKey}`)}
      .mode=${resolveLobsterPetMode(!gateway?.snapshot.offlineStable, options.context?.sessions.state.result?.sessions)}
      .runOutcome=${resolveLobsterRunOutcome(options.context?.sessions.state.result?.sessions)}
      .visitsEnabled=${options.context?.theme.settings.lobsterPetVisits !== false}
      .soundsEnabled=${options.context?.theme.settings.lobsterPetSounds === true}
      .gatewayVersion=${options.context?.config.current.serverVersion ?? gateway?.snapshot.hello?.server?.version ?? null}
      .onVisitsDisabled=${() => options.context?.theme.refresh()}
      .floorEnabled=${floorEnabled}
    ></openclaw-lobster-pet>`,
    attachmentLimits: options.context?.gateway.snapshot.hello?.policy?.attachments,
    attachments: options.attachmentDraft.attachments,
    canSubmit: options.canSubmit,
    getAttachments: () => options.attachmentDraft.attachments,
    get message() {
      return options.message;
    },
    mentions: options.mentions,
    getMentions: options.getMentions,
    mentionDirectory,
    visibility: options.visibility,
    draftAvailable: options.draftAvailable,
    capabilityMenu: options.capabilityMenu,
    toolOverrides: options.toolOverrides,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    permissionControl: options.permissionControl,
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    attachmentReads: options.attachmentDraft.reads,
    readSignal,
    requiresModifier: options.requiresModifier,
    requestUpdate: options.requestUpdate,
    refreshCommands: commandClient
      ? () =>
          refreshSlashCommands({
            client: commandClient,
            agentId: options.agentId,
            shouldApply: () =>
              options.textareaController.ownsSkillCommands(
                commandClient,
                options.agentId,
                options.draftOwnerKey,
              ),
          })
      : undefined,
    submitDisabledReason: options.submitDisabledReason,
    blockedSubmitNotice: options.blockedSubmitNotice,
    get dictationActive() {
      return options.dictationActive;
    },
    dictationPreview: options.dictationPreview,
    dictationStatus: options.dictationStatus,
    nativeTerminal: options.nativeTerminal,
    onUnsupportedAttachment: options.onUnsupportedAttachment,
    get submitting() {
      return options.submitting;
    },
    textareaController: options.textareaController,
    voiceControl: options.voiceControl,
    get messageLocked() {
      return options.messageLocked;
    },
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
    onInput: options.onInput,
    onOpenImage: options.onOpenImage,
    onOpenSidebar: options.onOpenSidebar,
    onVisibilityChange: options.onVisibilityChange,
    onSubmit: options.onSubmit,
    onBackgroundSubmit: options.onBackgroundSubmit,
  });
}
