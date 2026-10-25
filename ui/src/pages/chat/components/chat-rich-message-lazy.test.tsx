/* @vitest-environment jsdom */

import { createSignal, For } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createAsyncQuestionPresentation } from "./chat-async-question.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { prepareChatMessageRender } from "./chat-message-markdown-view.tsx";
import { createToolResultMessage } from "./chat-message.test-support.ts";

it("keeps ordinary transcript text synchronous", () => {
  const view = mountSolid(() => (
    <GroupedMessage
      preparation={prepareChatMessageRender({ role: "assistant", content: "Ready immediately" })}
      messageKey="plain"
      options={{ isStreaming: false, showReasoning: false }}
    />
  ));
  onTestFinished(view.unmount);
  expect(view.container.querySelector(".chat-text")?.textContent?.trim()).toBe("Ready immediately");
});

it("renders initial rich history and retires a superseded message during a held tool import", async () => {
  const gate = createDeferred();
  const load = vi.fn(() => gate.promise);
  vi.doMock(import("./chat-message-bubble-tools.tsx"), async (original) => {
    await load();
    return original();
  });
  onTestFinished(() => {
    gate.resolve();
    vi.doUnmock("./chat-message-bubble-tools.tsx");
  });
  const question = {
    role: "assistant",
    content: "Choose an audience.",
    openclawAsyncDelivery: {
      itemId: "initial-question",
      questions: [{ title: "Which audience?", options: ["Engineers", "Everyone"] }],
    },
  };
  const submit = vi.fn(async () => true);
  const questions = createAsyncQuestionPresentation(
    {
      asyncQuestionDrafts: new Map(),
      asyncQuestionRevision: 0,
      transcriptRenderContext: { onAsyncQuestionSubmit: submit },
    },
    { sessionKey: "agent:main:main", messages: [question], onAsyncQuestionSubmit: submit },
  );
  const initialTool = createToolResultMessage("old-call", "exec", "Old tool result");
  const [messages, setMessages] = createSignal([
    { key: "plain", message: { role: "assistant", content: "Visible during loading" } },
    { key: "question", message: question },
    { key: "old", message: initialTool },
  ]);
  const view = mountSolid(() => (
    <For each={messages()} keyed={(entry) => entry.key}>
      {(entry) => (
        <GroupedMessage
          preparation={prepareChatMessageRender(entry().message)}
          messageKey={entry().key}
          options={{ isStreaming: false, showReasoning: false, asyncQuestions: questions }}
        />
      )}
    </For>
  ));
  onTestFinished(view.unmount);
  expect(view.container.textContent).toContain("Visible during loading");
  await waitForSolid(() => expect(load).toHaveBeenCalled());

  const currentTool = createToolResultMessage("current-call", "exec", "Permission required", {
    details: {
      permissionMissing: {
        nodeId: "example-mac",
        nodeName: "Example Mac",
        command: "screen.capture",
        capabilities: ["screenRecording"],
        state: "denied",
      },
    },
  });
  setMessages((entries) => [...entries.slice(0, 2), { key: "current", message: currentTool }]);
  flush();
  gate.resolve();
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(view.container.querySelector(".chat-permission-card")).not.toBeNull();
    expect(view.container.querySelector(".chat-question-summary")?.textContent).toContain(
      "Which audience?",
    );
  });
  expect(view.container.textContent).toContain("Visible during loading");
  expect(view.container.querySelector('[data-message-id="old"]')).toBeNull();
  expect(view.container.textContent).not.toContain("Old tool result");
});
