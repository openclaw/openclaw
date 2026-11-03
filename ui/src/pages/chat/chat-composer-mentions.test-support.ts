import type { UsersMentionableResult } from "@openclaw/gateway-protocol";
import { expect, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { NewSessionAttachmentDraft } from "../new-session/attachment-draft.ts";
import {
  createNewSessionComposerTextarea,
  type NewSessionComposerTextarea,
} from "../new-session/composer-textarea.ts";
import { composerContext, mountNewSessionComposer } from "../new-session/composer.test-support.ts";
import type { NewSessionComposerOptions } from "../new-session/composer.tsx";
import { NewSessionModelControl } from "../new-session/model-control.ts";
import {
  createComposerContainer,
  createComposerProps,
  resetComposerFixture,
  disposeComposer,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import type { HumanMentionAccess } from "./components/chat-composer-mention-menu-state.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

export const people: UsersMentionableResult = {
  users: [
    { profileId: "profile-alex-online", displayName: "Alex", online: true },
    { profileId: "profile-alex-offline", displayName: "Alex", online: false },
  ],
  truncated: false,
};
export function mention(profileId: string, start = 0, end = 5): HumanMention {
  return { profileId, start, end };
}
const composerTextareas: NewSessionComposerTextarea[] = [];
type EditOptions = Pick<InputEventInit, "inputType" | "data"> &
  Partial<Record<"start" | "end" | "caret", number>>;

export async function resetMentionComposerFixture() {
  composerTextareas.splice(0).forEach((composerTextarea) => composerTextarea.disconnect());
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
  const container = createComposerContainer();
  document.body.append(container);
  let retired = false;
  let native: ReturnType<typeof mountNewSessionComposer> | undefined;
  let nativeOptions: NewSessionComposerOptions;
  const request = createGatewayRequestMock().mockResolvedValue(people);
  const client = createTestGatewayClient((method, params, options) =>
    method === "commands.list" ? { commands: [] } : request(method, params, options),
  );
  const composerTextarea = createNewSessionComposerTextarea();
  composerTextareas.push(composerTextarea);
  const context = composerContext({
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(
      ["sessions.create", "users.mentionable"],
      ["operator.sessions.write"],
    ),
    selfUser: { id: "sender-one", identity: { type: "profile", id: "sender-one" } },
  });
  const attachmentDraft = new NewSessionAttachmentDraft(renderCurrent, () => {});
  const modelControl = new NewSessionModelControl(renderCurrent);
  onTestFinished(() => {
    retired = true;
    attachmentDraft.reset();
    if (native) {
      native.unmount();
    } else {
      disposeComposer(container);
    }
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
  let mentionAccess: HumanMentionAccess | undefined;
  const props = createComposerProps({
    registerHumanMentionAccess: (access) => {
      mentionAccess = access;
      return () => {
        if (mentionAccess === access) {
          mentionAccess = undefined;
        }
      };
    },
  });
  function renderCurrent() {
    if (retired) {
      return;
    }
    if (kind === "chat") {
      renderComposerInto(container, {
        ...props,
        submitDisabledReason,
        draft,
        mentions,
        getDraft: () => draft,
        getMentions: () => mentions,
        mentionDirectory: unsupported
          ? undefined
          : { client, ownerKey, params: { sessionKey: "agent:main:chat" } },
        mentionsUnsupported: unsupported,
        onDraftChange: onInput,
        onSlashCommand: slashCommand,
        canAbort: true,
        onAbort: abort,
        onSend: () => send({ draft, mentions }),
      });
    } else {
      nativeOptions = {
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
        onChange: renderCurrent,
        submitting: false,
        onInput: (next, selected) => {
          onInput(next, selected);
          renderCurrent();
        },
        onSubmit: () => send({ draft, mentions }),
      };
      if (native) {
        native.rerender();
      } else {
        native = mountNewSessionComposer(() => nativeOptions, composerTextarea, container);
      }
    }
  }
  renderCurrent();
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
  const edit = (next: string, options: EditOptions = {}) => {
    const start = options.start ?? textarea.value.length;
    const caret = options.caret ?? next.length;
    const eventInit = {
      bubbles: true,
      inputType: options.inputType ?? "insertText",
      data: options.data ?? next,
    };
    textarea.setSelectionRange(start, options.end ?? start);
    textarea.dispatchEvent(new InputEvent("beforeinput", eventInit));
    textarea.value = next;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new InputEvent("input", eventInit));
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
    defer: () => {
      const response = createDeferred<UsersMentionableResult>();
      request.mockReturnValueOnce(response.promise);
      return async (result = people) => {
        response.resolve(result);
        await vi.advanceTimersByTimeAsync(0);
        await vi.dynamicImportSettled();
      };
    },
    edit,
    query: container.querySelector.bind(container),
    options: () => container.querySelectorAll('[role="option"]'),
    search: async (text: string, options?: Parameters<typeof edit>[1]) => {
      edit(text, options);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(150);
      await vi.dynamicImportSettled();
    },
    key: pressKey,
    send,
    abort,
    slashCommand,
    value: () => ({ draft, mentions }),
    expectValue: (expectedDraft: string, expectedMentions: readonly HumanMention[] = []) =>
      expect({ draft, mentions }).toEqual({ draft: expectedDraft, mentions: expectedMentions }),
    mentionAccess: () => mentionAccess,
    refresh: renderCurrent,
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
