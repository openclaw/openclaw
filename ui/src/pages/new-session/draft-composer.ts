import { html, nothing, type TemplateResult } from "lit";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  lobsterPetSeed,
  resolveLobsterPetMode,
  resolveLobsterRunOutcome,
} from "../../components/lobster-pet-contract.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { refreshSlashCommands } from "../chat/chat-commands.ts";
import type { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import type { NewSessionComposerOptions } from "./composer-types.ts";
import { renderNewSessionComposer } from "./composer.ts";
import { isWorktreeNameValid } from "./create-params.ts";
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

export function renderNewSessionDraftComposer(
  options: Omit<
    NewSessionComposerOptions,
    | "renderCritters"
    | "attachmentLimits"
    | "attachmentReads"
    | "attachments"
    | "getAttachments"
    | "mentionDirectory"
    | "modelControl"
    | "permissionControl"
    | "pendingAttachmentReads"
    | "readSignal"
    | "refreshCommands"
    | "onAttachmentsChange"
    | "onPendingReadsChange"
  > & {
    agent?: GatewayAgentRow;
    agentId: string;
    attachmentDraft: NewSessionAttachmentDraft;
    context: ApplicationContext | undefined;
    draftOwnerKey: string;
    isCatalogTarget: boolean;
    modelControl: NewSessionModelControl;
    permissionControl?: TemplateResult;
  },
) {
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
    ...options,
    renderCritters: (floorEnabled) => html`<openclaw-lobster-pet
      .seed=${lobsterPetSeed(`${options.textareaController.critterVisit}:${options.draftOwnerKey}`)}
      .mode=${resolveLobsterPetMode(!gateway?.snapshot.offlineStable, options.context?.sessions.state.result?.sessions)}
      .runOutcome=${resolveLobsterRunOutcome(options.context?.sessions.state.result?.sessions)}
      .visitsEnabled=${options.context?.theme.settings.lobsterPetVisits !== false}
      .residentEnabled=${options.context?.theme.branding.mascot !== "none"}
      .critters=${options.context?.theme.branding.critters}
      .critterArtwork=${options.context?.theme.branding.artwork?.critters}
      .soundsEnabled=${options.context?.theme.settings.lobsterPetSounds === true}
      .gatewayVersion=${options.context?.config.current.serverVersion ?? gateway?.snapshot.hello?.server?.version ?? null}
      .onVisitsDisabled=${() => options.context?.theme.refresh()}
      .floorEnabled=${floorEnabled}
    ></openclaw-lobster-pet>`,
    attachmentLimits: options.context?.gateway.snapshot.hello?.policy?.attachments,
    attachments: options.attachmentDraft.attachments,
    getAttachments: () => options.attachmentDraft.attachments,
    get message() {
      return options.message;
    },
    mentionDirectory,
    modelControl: options.isCatalogTarget
      ? nothing
      : options.modelControl.render({
          agent: options.agent,
          agentId: options.agentId,
          context: options.context,
          sending: options.submitting,
        }),
    pendingAttachmentReads: options.attachmentDraft.pendingReads,
    attachmentReads: options.attachmentDraft.reads,
    readSignal,
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
    get dictationActive() {
      return options.dictationActive;
    },
    get submitting() {
      return options.submitting;
    },
    get messageLocked() {
      return options.messageLocked;
    },
    onAttachmentsChange: (attachments) => {
      if (!options.submitting && !options.messageLocked) {
        options.attachmentDraft.replace(attachments);
      }
    },
    onPendingReadsChange: (delta) => options.attachmentDraft.updatePending(readSignal, delta),
  });
}
