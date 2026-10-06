import { render, type TemplateResult } from "lit";
import { onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { installChatComposerPickerDismissal } from "../chat/components/chat-picker-overlay.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaController } from "./composer-controller.ts";
import type { NewSessionVisibility } from "./create-params.ts";
import { renderNewSessionDraftComposer } from "./draft-composer.ts";
import { NewSessionModelControl } from "./model-control.ts";

const attachmentDrafts: NewSessionAttachmentDraft[] = [];
const textareaControllers: NewSessionComposerTextareaController[] = [];

export function composerContext(snapshot: { client: GatewayBrowserClient | null }) {
  return {
    gateway: { snapshot },
    config: { current: {} },
    sessions: { state: { result: null } },
    theme: {
      branding: { mascot: "claw", critters: [] },
      settings: { lobsterPetVisits: true, lobsterPetSounds: false },
      refresh: vi.fn(),
    },
  } as unknown as ApplicationContext;
}

export function renderComposer(
  overrides: {
    canSubmit?: boolean;
    requiresModifier?: boolean;
    submitDisabledReason?: string;
    blockedSubmitNotice?: string;
    dictationActive?: boolean;
    dictationPreview?: string;
    dictationStatus?: TemplateResult;
    nativeTerminal?: boolean;
    onUnsupportedAttachment?: () => void;
    submitting?: boolean;
    messageLocked?: boolean;
    visibility?: NewSessionVisibility;
    draftAvailable?: boolean;
    toolOverrides?: SessionToolOverrides | null;
    onVisibilityChange?: (visibility: NewSessionVisibility) => void;
    message?: string;
    draftOwnerKey?: string;
    agentId?: string;
    context?: ApplicationContext;
    onInput?: (message: string) => void;
    onSubmit?: () => void;
    onBackgroundSubmit?: () => void;
    textareaController?: NewSessionComposerTextareaController;
  } = {},
) {
  onTestFinished(installChatComposerPickerDismissal(document));
  const container = document.createElement("div");
  const attachmentDraft = new NewSessionAttachmentDraft(
    () => undefined,
    () => undefined,
  );
  attachmentDrafts.push(attachmentDraft);
  const textareaController =
    overrides.textareaController ?? new NewSessionComposerTextareaController();
  if (!textareaControllers.includes(textareaController)) {
    textareaControllers.push(textareaController);
  }
  let message = overrides.message ?? "";
  let agentId = overrides.agentId ?? "main";
  let draftOwnerKey = overrides.draftOwnerKey ?? "draft:one";
  const renderCurrent = () =>
    render(
      renderNewSessionDraftComposer({
        agentId,
        attachmentDraft,
        canSubmit: overrides.canSubmit ?? true,
        context: overrides.context,
        draftOwnerKey,
        isCatalogTarget: true,
        message,
        visibility: overrides.visibility,
        draftAvailable: overrides.draftAvailable,
        toolOverrides: overrides.toolOverrides,
        modelControl: new NewSessionModelControl(() => undefined),
        requiresModifier: overrides.requiresModifier ?? false,
        requestUpdate: renderCurrent,
        submitDisabledReason: overrides.submitDisabledReason,
        blockedSubmitNotice: overrides.blockedSubmitNotice,
        dictationActive: overrides.dictationActive,
        dictationPreview: overrides.dictationPreview,
        dictationStatus: overrides.dictationStatus,
        nativeTerminal: overrides.nativeTerminal,
        onUnsupportedAttachment: overrides.onUnsupportedAttachment,
        submitting: overrides.submitting ?? false,
        textareaController,
        messageLocked: overrides.messageLocked,
        onInput: (next) => {
          message = next;
          overrides.onInput?.(next);
          renderCurrent();
        },
        onVisibilityChange: overrides.onVisibilityChange,
        onSubmit: overrides.onSubmit ?? (() => undefined),
        onBackgroundSubmit: overrides.onBackgroundSubmit,
      }),
      container,
    );
  renderCurrent();
  const composer = container.querySelector<HTMLElement>(".new-session-page__composer");
  if (!composer) {
    throw new Error("Expected new-session composer");
  }
  return {
    attachmentDraft,
    composer,
    container,
    textareaController,
    rerender: renderCurrent,
    rerenderForAgent: (nextAgentId: string) => {
      agentId = nextAgentId;
      renderCurrent();
    },
    rerenderForDraftRoute: (nextDraftOwnerKey: string, nextMessage: string) => {
      draftOwnerKey = nextDraftOwnerKey;
      message = nextMessage;
      renderCurrent();
    },
  };
}

export function resetComposerTestFixtures() {
  for (const attachmentDraft of attachmentDrafts) {
    attachmentDraft.reset({ release: true });
  }
  attachmentDrafts.length = 0;
  for (const textareaController of textareaControllers) {
    textareaController.disconnect();
  }
  textareaControllers.length = 0;
}
