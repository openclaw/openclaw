import { createComponent, createSignal, flush, getOwner } from "solid-js";
import { onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { installChatComposerPickerDismissal } from "../chat/components/chat-picker-overlay.ts";
import { NewSessionAttachmentDraft } from "./attachment-draft.ts";
import { NewSessionComposerTextareaContext } from "./composer-textarea-context.ts";
import {
  createNewSessionComposerTextarea,
  type NewSessionComposerTextarea,
} from "./composer-textarea.ts";
import { NewSessionComposer, type NewSessionComposerOptions } from "./composer.tsx";
import { NewSessionModelControl } from "./model-control.ts";

const attachmentDrafts: NewSessionAttachmentDraft[] = [];
const composerTextareas: NewSessionComposerTextarea[] = [];

export function composerContext(
  snapshot: Partial<ApplicationGatewaySnapshot> & { client: GatewayBrowserClient | null },
) {
  return {
    gateway: {
      snapshot,
      connection: { gatewayUrl: "ws://gateway.test" },
      connectionRevision: 0,
      subscribe: () => () => {},
    },
    agents: { subscribe: () => () => {} },
    config: { current: {}, subscribe: () => () => {} },
    sessions: { state: { result: null }, subscribe: () => () => {} },
    theme: {
      branding: resolveThemeBranding(undefined),
      settings: { lobsterPetVisits: true, lobsterPetSounds: false },
      refresh: vi.fn(),
    },
  } as unknown as ApplicationContext;
}

export function renderComposer(
  overrides: Partial<
    Omit<
      NewSessionComposerOptions,
      "attachmentDraft" | "modelControl" | "onChange" | "isCatalogTarget"
    >
  > & {
    composerTextarea?: NewSessionComposerTextarea;
  } = {},
) {
  onTestFinished(installChatComposerPickerDismissal(document));
  const container = document.createElement("div");
  const attachmentDraft = new NewSessionAttachmentDraft(
    () => undefined,
    () => undefined,
  );
  attachmentDrafts.push(attachmentDraft);
  const composerTextarea = overrides.composerTextarea ?? createNewSessionComposerTextarea();
  if (!composerTextareas.includes(composerTextarea)) {
    composerTextareas.push(composerTextarea);
  }
  let message = overrides.message ?? "";
  let agentId = overrides.agentId ?? "main";
  let draftOwnerKey = overrides.draftOwnerKey ?? "draft:one";
  let commandProjectId = overrides.commandProjectId;
  const currentOptions = (): NewSessionComposerOptions => ({
    ...overrides,
    agentId,
    commandProjectId,
    attachmentDraft,
    canSubmit: overrides.canSubmit ?? true,
    context: overrides.context,
    draftOwnerKey,
    isCatalogTarget: true,
    message,
    modelControl: new NewSessionModelControl(() => undefined),
    requiresModifier: overrides.requiresModifier ?? false,
    onChange: renderCurrent,
    submitting: overrides.submitting ?? false,
    onInput: (next) => {
      message = next;
      overrides.onInput?.(next);
      renderCurrent();
    },
    onSubmit: overrides.onSubmit ?? (() => undefined),
  });
  const renderCurrent = () => mounted.rerender();
  const mounted = mountNewSessionComposer(currentOptions, composerTextarea, container);
  const composer = container.querySelector<HTMLElement>(".new-session-page__composer");
  if (!composer) {
    throw new Error("Expected new-session composer");
  }
  return {
    attachmentDraft,
    composer,
    container,
    composerTextarea,
    rerender: renderCurrent,
    unmount: mounted.unmount,
    rerenderWithMessage: (nextMessage: string) => {
      message = nextMessage;
      renderCurrent();
    },
    rerenderForAgent: (nextAgentId: string) => {
      agentId = nextAgentId;
      renderCurrent();
    },
    rerenderForProject: (nextProjectId: string | undefined) => {
      commandProjectId = nextProjectId;
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
    attachmentDraft.reset();
  }
  attachmentDrafts.length = 0;
  for (const composerTextarea of composerTextareas) {
    composerTextarea.disconnect();
  }
  composerTextareas.length = 0;
}

export function mountNewSessionComposer(
  read: () => NewSessionComposerOptions,
  textarea: NewSessionComposerTextarea,
  container: HTMLElement,
) {
  let update: (options: NewSessionComposerOptions) => void;
  const mounted = mountSolid(
    () => {
      const [options, setOptions] = createSignal(read());
      update = setOptions;
      return createComponent(NewSessionComposer, {
        get options() {
          return options();
        },
      });
    },
    {
      container,
      wrapper: (props) =>
        createComponent(NewSessionComposerTextareaContext, {
          value: textarea,
          get children() {
            return props.children;
          },
        }),
    },
  );
  return {
    ...mounted,
    rerender() {
      update(read());
      if (!getOwner()) {
        flush();
      }
    },
  };
}
