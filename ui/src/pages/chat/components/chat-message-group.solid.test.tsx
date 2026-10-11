/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { LitContent } from "../../../lit/solid-content.tsx";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { MessageGroup, type NativeMessageGroupOptions } from "./chat-message-group-view.tsx";
import { renderActivityGroup } from "./chat-message-group.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";

it("keeps distinct peer avatars and focused message content across group updates", async () => {
  const imageData =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const message = (alt: string) => ({
    role: "user",
    content: [
      { type: "text", text: "A retained paragraph." },
      { type: "image", data: imageData, mimeType: "image/png", alt },
    ],
    timestamp: 1000,
  });
  const group = createMessageGroup(message("Peer image"), "user", {
    key: "peer-group",
    senderLabel: "Peer",
    sender: { id: "peer", name: "Peer", identity: { type: "profile", id: "peer" } },
    messages: [
      { key: "peer-first", message: message("Peer image") },
      {
        key: "peer-second",
        message: { role: "user", content: "Another message.", timestamp: 1001 },
      },
    ],
  });
  const [currentGroup, setGroup] = createSignal(group);
  const [options, setOptions] = createSignal<NativeMessageGroupOptions>({
    userId: "viewer",
    userName: "Viewer",
    showReasoning: false,
    showToolCalls: false,
  });
  const view = mountSolid(() => <MessageGroup group={currentGroup()} options={options()} />);
  await waitForSolid(() => {
    expect(view.container.querySelectorAll(".chat-bubble .chat-avatar-slot")).toHaveLength(2);
    expect(view.getByRole("button", { name: "Open image Peer image" })).toBeDefined();
    expect(view.container.querySelector(".chat-text p")?.textContent).toBe("A retained paragraph.");
  });
  const bubbles = [...view.container.querySelectorAll(".chat-bubble")];
  expect(bubbles).toHaveLength(2);
  const avatars = [...view.container.querySelectorAll(".chat-bubble .chat-avatar-slot")];
  expect(avatars[0]).not.toBe(avatars[1]);
  avatars.forEach((avatar, index) => {
    expect(avatar.closest(".chat-bubble")).toBe(bubbles[index]);
    expect(avatar.querySelector('[aria-label="Peer"]')).not.toBeNull();
  });
  const control = view.getByRole("button", { name: "Open image Peer image" });
  const image = control.querySelector("img")!;
  const paragraph = view.container.querySelector(".chat-text p");
  image.dispatchEvent(new Event("load"));
  control.focus();
  expect(document.activeElement).toBe(control);

  setGroup({
    ...group,
    senderLabel: "Peer Updated",
    sender: { ...group.sender!, name: "Peer Updated" },
    messages: [
      { ...group.messages[0]!, message: message("Updated peer image") },
      { ...group.messages[1]! },
    ],
  });
  setOptions((previous) => ({ ...previous, userName: "Updated Viewer" }));
  flush();
  await waitForSolid(() => {
    expect(view.getByRole("button", { name: "Open image Updated peer image" })).toBe(control);
    expect(view.container.querySelector(".chat-sender-name")?.textContent).toBe("Peer Updated");
  });
  expect(document.activeElement).toBe(control);
  expect(control.querySelector("img")).toBe(image);
  expect(view.container.querySelector(".chat-text p")).toBe(paragraph);
  const updatedBubbles = view.container.querySelectorAll(".chat-bubble");
  bubbles.forEach((bubble, index) => expect(updatedBubbles[index]).toBe(bubble));
  const updatedAvatars = [...view.container.querySelectorAll(".chat-bubble .chat-avatar-slot")];
  expect(updatedAvatars).toHaveLength(2);
  expect(updatedAvatars[0]).not.toBe(updatedAvatars[1]);
  expect(
    updatedAvatars.every((avatar) => avatar.querySelector('[aria-label="Peer Updated"]') !== null),
  ).toBe(true);
});

it("retains aggregate disclosure and legacy card focus when options refresh", async () => {
  const messages = ["one", "two"].map((key, index) => ({
    key,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: `call-${key}`, name: "read", input: { path: `${key}.md` } },
      ],
      timestamp: 1000 + index,
    },
  }));
  const group = createMessageGroup(messages[0]!.message, "tool", {
    key: "activity",
    messages,
  });
  const [options, setOptions] = createSignal<NativeMessageGroupOptions>({
    showReasoning: false,
    showToolCalls: true,
    isToolMessageExpanded: () => true,
  });
  const view = mountSolid(() => <LitContent value={renderActivityGroup([group], options())} />);
  await waitForSolid(() => {
    expect(
      view.container.querySelectorAll(".chat-tools-inline .chat-tool-msg-collapse"),
    ).toHaveLength(2);
  });
  const summary = view.container.querySelector<HTMLButtonElement>(".chat-activity-group__summary")!;
  const card = view.container.querySelector(".chat-tools-inline .chat-tool-msg-collapse");
  const cardControl = card!.querySelector<HTMLButtonElement>("button")!;
  cardControl.focus();
  setOptions((previous) => ({ ...previous, assistantName: "Updated assistant" }));
  flush();
  expect(document.activeElement).toBe(cardControl);
  expect(view.container.querySelector(".chat-tools-inline .chat-tool-msg-collapse")).toBe(card);
  expect(view.container.querySelector(".chat-activity-group__summary")).toBe(summary);
  summary.focus();
  setOptions((previous) => ({ ...previous, userName: "Updated viewer" }));
  flush();
  expect(document.activeElement).toBe(summary);
  expect(view.container.querySelector(".chat-activity-group__summary")).toBe(summary);
});
