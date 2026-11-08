/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import * as media from "./chat-message-media.ts";
import {
  createAssistantMessage,
  createToolCall,
  createToolResultBlock,
} from "./chat-message.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  resetTranscriptTestDom();
});

async function settle() {
  for (let turn = 0; turn < 6; turn++) {
    await Promise.resolve();
    flush();
  }
}

it("keeps an unchanged tool's projection, focus, and disclosure while its sibling streams", async () => {
  const project = vi.spyOn(media, "projectMessageMedia");
  const first = createAssistantMessage(
    [
      createToolCall("first", "read", { path: "src/first.ts" }),
      createToolResultBlock("first", "read", "first output"),
    ],
    { timestamp: 1 },
  );
  const secondMessage = (output: string) =>
    createAssistantMessage(
      [
        createToolCall("second", "read", { path: "src/second.ts" }),
        createToolResultBlock("second", "read", output),
      ],
      { timestamp: 2 },
    );
  const firstPreparation = prepareChatMessageRender(first);
  const repeatedPreparation = prepareChatMessageRender(first);
  const previousOpen = vi.fn();
  const currentOpen = vi.fn();
  const previousToggle = vi.fn();
  const currentToggle = vi.fn();
  const options: GroupedMessageOptions = {
    isStreaming: false,
    showReasoning: false,
    isToolExpanded: () => true,
    onToggleToolExpanded: previousToggle,
    onOpenWorkspaceFile: previousOpen,
  };
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(
    (props: {
      first: ReturnType<typeof prepareChatMessageRender>;
      second: unknown;
      options: GroupedMessageOptions;
    }) => (
      <>
        <GroupedMessage
          preparation={props.first}
          messageKey="prepared-first"
          options={props.options}
        />
        <GroupedMessage
          preparation={prepareChatMessageRender(props.second)}
          messageKey="prepared-second"
          options={props.options}
        />
      </>
    ),
    { first: firstPreparation, second: secondMessage("second output"), options },
    container,
  );
  disposers.push(view.dispose);
  const firstBubble = () => container.querySelector('[data-message-id="prepared-first"]')!;
  await waitForSolid(() => {
    expect(firstBubble().querySelector(".chat-tool-row:not([aria-busy])")).not.toBeNull();
    expect(container.textContent).toContain("second output");
  });
  await settle();
  const row = firstBubble().querySelector<HTMLElement>(".chat-tool-row")!;
  const toggle = row.querySelector<HTMLButtonElement>(".chat-tool-row__toggle")!;
  const disclosure = firstBubble().querySelector(".chat-tool-msg-collapse")!;
  const firstProjects = () => project.mock.calls.filter(([source]) => source === first).length;
  const before = firstProjects();
  expect(before).toBeGreaterThan(0);
  expect(disclosure.classList.contains("is-open")).toBe(true);
  toggle.focus();
  expect(document.activeElement).toBe(toggle);
  const second = secondMessage("second output updated");
  view.update({
    first: repeatedPreparation,
    second,
    options: {
      ...options,
      onToggleToolExpanded: currentToggle,
      onOpenWorkspaceFile: currentOpen,
    },
  });
  await waitForSolid(() => expect(container.textContent).toContain("second output updated"));
  expect(firstProjects()).toBe(before);
  expect(project.mock.calls.some(([source]) => source === second)).toBe(true);
  expect(firstBubble().querySelector(".chat-tool-row")).toBe(row);
  expect(firstBubble().querySelector(".chat-tool-msg-collapse")).toBe(disclosure);
  expect(disclosure.classList.contains("is-open")).toBe(true);
  expect(document.activeElement).toBe(toggle);
  firstBubble().querySelector<HTMLButtonElement>(".chat-tool-card__detail-link")!.click();
  expect(currentOpen).toHaveBeenCalledWith({ path: "src/first.ts" });
  expect(previousOpen).not.toHaveBeenCalled();
  toggle.click();
  expect(currentToggle).toHaveBeenCalledWith("prepared-first:toolcard:0", true);
  expect(previousToggle).not.toHaveBeenCalled();
  view.update({
    first: prepareChatMessageRender(first),
    second,
    options: { ...options, onOpenWorkspaceFile: undefined },
  });
  await settle();
  expect(firstProjects()).toBe(before);
  expect(firstBubble().querySelector(".chat-tool-card__detail-link")).toBeNull();
  expect(firstBubble().querySelector(".chat-tool-row__file-link")).toBeNull();
});

it("publishes same-card completion and error changes without reprojecting message content", async () => {
  const message = createAssistantMessage(
    [createToolCall("progress", "exec", { command: "diagnostic" })],
    { timestamp: 1, __openclawToolStreamLive: true },
  );
  const card = extractToolCardsCached(message)[0]!;
  card.outputText = '{"error":"progress sample"}';
  const project = vi.spyOn(media, "projectMessageMedia");
  const options: GroupedMessageOptions = {
    isStreaming: false,
    showReasoning: false,
    runActive: true,
    isToolExpanded: () => true,
  };
  const view = mountSolid(
    GroupedMessage,
    { preparation: prepareChatMessageRender(message), messageKey: "prepared-progress", options },
    document.body.appendChild(document.createElement("div")),
  );
  disposers.push(view.dispose);
  await waitForSolid(() => {
    expect(view.container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("Running");
    expect(view.container.textContent).toContain(card.outputText);
  });
  const before = project.mock.calls.length;
  card.completed = true;
  card.isError = false;
  view.update({
    preparation: prepareChatMessageRender(message),
    messageKey: "prepared-progress",
    options: { ...options },
  });
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("Completed"),
  );
  expect(view.container.querySelector(".chat-tool-row--running")).toBeNull();
  expect(view.container.querySelector(".chat-tool-card--error")).toBeNull();
  card.isError = true;
  view.update({
    preparation: prepareChatMessageRender(message),
    messageKey: "prepared-progress",
    options: { ...options },
  });
  await waitForSolid(() =>
    expect(view.container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed"),
  );
  expect(view.container.querySelector(".chat-tool-card--error")).not.toBeNull();
  expect(extractToolCardsCached(message)[0]).toBe(card);
  expect(project.mock.calls.length).toBe(before);
});
