import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { nothing, render } from "lit";
import { onTestFinished, vi } from "vitest";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { NewSessionAttachmentDraft } from "../new-session/attachment-draft.ts";
/* @vitest-environment jsdom */
import { NewSessionComposerTextareaController } from "../new-session/composer-controller.ts";
import { composerContext } from "../new-session/composer.test-support.ts";
import { renderNewSessionComposer } from "../new-session/composer.ts";
import { NewSessionModelControl } from "../new-session/model-control.ts";
import { createComposerProps, resetComposerFixture } from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

export const people: UsersMentionableResult = {
  users: [
    { profileId: "profile-alex-online", displayName: "Alex", online: true },
    { profileId: "profile-alex-offline", displayName: "Alex", online: false },
  ],
  truncated: false,
};
const controllers: NewSessionComposerTextareaController[] = [];

export async function resetMentionComposerFixture() {
  controllers.splice(0).forEach((controller) => controller.disconnect());
  await resetComposerFixture();
}

export function composerFixture(
  kind: "chat" | "new-session",
  initial = "",
  initialMentions: readonly HumanMention[] = [],
  submitDisabledReason?: string,
) {
  vi.useFakeTimers();
  onTestFinished(installChatComposerPickerDismissal(document));
  const container = document.createElement("div");
  document.body.append(container);
  let retired = false;
  const request = createGatewayRequestMock().mockResolvedValue(people);
  const client = createTestGatewayClient((method, params, options) =>
    method === "commands.list" ? { commands: [] } : request(method, params, options),
  );
  const controller = new NewSessionComposerTextareaController();
  controllers.push(controller);
  const context = composerContext({
    client,
    phase: "connected",
    selfUser: { id: "sender-one", identity: { type: "profile", id: "sender-one" } },
  });
  const attachmentDraft = new NewSessionAttachmentDraft(
    () => renderCurrent(),
    () => {},
  );
  const modelControl = new NewSessionModelControl(() => renderCurrent());
  onTestFinished(() => {
    retired = true;
    attachmentDraft.reset();
    render(nothing, container);
    container.remove();
  });
  let draft = initial;
  let mentions = initialMentions;
  let ownerKey = "sender-one";
  let unsupported = false;
  const send = vi.fn();
  const abort = vi.fn();
  const slashCommand = vi.fn();
  const onInput = (next: string, selected?: readonly HumanMention[]) => {
    mentions = selected ?? updateHumanMentions(draft, next, mentions);
    draft = next;
  };
  const props = createComposerProps();
  const renderCurrent = () => {
    if (retired) {
      return;
    }
    const directory = {
      client,
      ownerKey,
      params: kind === "chat" ? { sessionKey: "agent:main:chat" } : { agentId: "main" },
    };
    render(
      kind === "chat"
        ? renderChatComposer({
            ...props,
            submitDisabledReason,
            draft,
            mentions,
            getDraft: () => draft,
            getMentions: () => mentions,
            mentionDirectory: unsupported ? undefined : directory,
            mentionsUnsupported: unsupported,
            onDraftChange: onInput,
            onRequestUpdate: renderCurrent,
            onSlashCommand: slashCommand,
            canAbort: true,
            onAbort: abort,
            onSend: () => send({ draft, mentions }),
          })
        : renderNewSessionComposer({
            agentId: "main",
            context,
            draftOwnerKey: ownerKey,
            attachmentDraft,
            modelControl,
            isCatalogTarget: false,
            message: draft,
            mentions,
            getMentions: () => mentions,
            canSubmit: true,
            requiresModifier: false,
            requestUpdate: renderCurrent,
            submitting: false,
            textareaController: controller,
            onInput: (next, selected) => {
              onInput(next, selected);
              renderCurrent();
            },
            onSubmit: () => send({ draft, mentions }),
          }),
      container,
    );
  };
  renderCurrent();
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const edit = (
    next: string,
    options: {
      start?: number;
      end?: number;
      caret?: number;
      inputType?: string;
      data?: string | null;
    } = {},
  ) => {
    const inputType = options.inputType ?? "insertText";
    textarea.setSelectionRange(
      options.start ?? textarea.value.length,
      options.end ?? options.start ?? textarea.value.length,
    );
    textarea.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType, data: options.data ?? next }),
    );
    textarea.value = next;
    textarea.setSelectionRange(options.caret ?? next.length, options.caret ?? next.length);
    textarea.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType, data: options.data ?? next }),
    );
    renderCurrent();
  };
  const pressKey = (key: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...extra });
    textarea.dispatchEvent(event);
    renderCurrent();
    return event;
  };
  return {
    container,
    request,
    edit,
    key: pressKey,
    send,
    abort,
    slashCommand,
    value: () => ({ draft, mentions }),
    replaceOwner: () => {
      ownerKey = "sender-two";
      renderCurrent();
    },
    setUnsupported: () => {
      unsupported = true;
      renderCurrent();
    },
  };
}
