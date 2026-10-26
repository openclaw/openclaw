/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  renderComposerFixture,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import type { ChatQuestionPanel } from "./components/chat-question-panel.tsx";

afterEach(() => resetComposerFixture());

it.each(["draft", "focus"])(
  "preserves optional-question disclosure while editing via %s",
  async (editing) => {
    const { container, props } = renderComposerFixture({
      draft: editing === "draft" ? "Keep writing" : "",
      onAsyncQuestionSubmit: async () => true,
    });
    document.body.append(container);
    const textarea = await waitForSolid(() =>
      expectDefined(container.querySelector<HTMLTextAreaElement>("textarea"), "composer textarea"),
    );
    if (editing === "focus") {
      textarea.focus();
    }
    const focused = document.activeElement;
    props.messages = [
      {
        role: "assistant",
        openclawAsyncDelivery: { itemId: "audience", questions: [{ title: "Which audience?" }] },
      },
    ];
    const read = async (collapsed: boolean | null) => {
      renderComposerInto(container, props);
      return waitForSolid(() => {
        const panel = container.querySelector<ChatQuestionPanel>(
          "openclaw-chat-question-panel",
        )?.props;
        expect(panel ? panel.model.collapsed : null).toBe(collapsed);
        return panel;
      });
    };
    expect((await read(true))!.model).toMatchObject({ nonBlocking: true, autoFocus: false });
    props.connectionEpoch = 1;
    await read(true);
    expect(document.activeElement).toBe(focused);
    const submit = props.onAsyncQuestionSubmit;
    props.onAsyncQuestionSubmit = undefined;
    await read(null);
    props.connectionEpoch = 2;
    props.onAsyncQuestionSubmit = submit;
    (await read(true))!.onCollapsedChange?.(false);
    await read(false);
    textarea.focus();
    props.connectionEpoch = 3;
    const panel = (await read(false))!;
    document.body.appendChild(document.createElement("button")).focus();
    panel.onCollapsedChange?.(true);
    await Promise.resolve();
    expect(document.activeElement).toBe(textarea);
  },
);
